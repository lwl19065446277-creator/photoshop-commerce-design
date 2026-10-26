"""Read XLSX text/strike metadata without saving the workbook or fetching links."""
import argparse,hashlib,json,posixpath,re,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

M='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS={'m':M}
MAX_PART=32*1024*1024
MAX_TOTAL=96*1024*1024

def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()

def flag(element):
    return element is not None and element.get('val','1').lower() not in ['0','false','off']

def rich(element,base_strike=False):
    if element is None:return '',[],''
    runs=[]
    for child in element:
        tag=child.tag.rsplit('}',1)[-1]
        if tag=='t':runs.append({'text':child.text or '', 'strike':base_strike})
        elif tag=='r':
            props=child.find('m:rPr',NS)
            strike=props.find('m:strike',NS) if props is not None else None
            color=props.find('m:color',NS) if props is not None else None
            runs.append({'text':''.join(n.text or '' for n in child.findall('m:t',NS)),
                         'strike':flag(strike) if strike is not None else base_strike,
                         'color':dict(color.attrib) if color is not None else None})
    return ''.join(r['text'] for r in runs),runs,''.join(r['text'] for r in runs if not r['strike'])

def read_book(path):
    path=Path(path).resolve()
    if path.suffix.lower()!='.xlsx':raise ValueError('Only an explicit XLSX input is supported')
    before=sha(path);total=0
    with zipfile.ZipFile(path) as z:
        names=z.namelist()
        if len(names)!=len(set(names)):raise ValueError('Duplicate ZIP member')
        def xml(name,optional=False):
            nonlocal total
            if name not in names:
                if optional:return None
                raise ValueError('Missing XLSX part: '+name)
            info=z.getinfo(name);total+=info.file_size
            if info.file_size>MAX_PART or total>MAX_TOTAL:raise ValueError('XLSX text XML limit exceeded; do not resave the original to work around it')
            raw=z.read(name)
            if re.search(br'<!\s*(?:DOCTYPE|ENTITY)',raw,re.I):raise ValueError('DTD/entity XML is not supported')
            return ET.fromstring(raw)
        def relationships(part):
            parent,pos=posixpath.split(part)
            doc=xml(posixpath.join(parent,'_rels',pos+'.rels'),True)
            return {} if doc is None else {n.get('Id'):dict(n.attrib) for n in doc}
        def local_target(part,relation):
            if relation.get('TargetMode')=='External':raise ValueError('External worksheet parts are not followed')
            target=relation['Target'].replace('\\','/')
            target=posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(posixpath.dirname(part),target))
            if not target.startswith('xl/') or '..' in target.split('/'):raise ValueError('Worksheet target escaped the workbook package')
            return target
        shared=xml('xl/sharedStrings.xml',True)
        strings=[] if shared is None else list(shared)
        styles=xml('xl/styles.xml',True)
        fonts=[] if styles is None or styles.find('m:fonts',NS) is None else list(styles.find('m:fonts',NS))
        xfs=[] if styles is None or styles.find('m:cellXfs',NS) is None else list(styles.find('m:cellXfs',NS))
        workbook=xml('xl/workbook.xml');rels=relationships('xl/workbook.xml');sheets=[]
        for sheet in workbook.findall('m:sheets/m:sheet',NS):
            target=local_target('xl/workbook.xml',rels[sheet.get('{'+R+'}id')]);body=xml(target);links=relationships(target);cells=[]
            for row in body.findall('m:sheetData/m:row',NS):
                for c in row.findall('m:c',NS):
                    index=int(c.get('s','0'));font_id=int(xfs[index].get('fontId','0')) if index<len(xfs) else 0
                    strike=flag(fonts[font_id].find('m:strike',NS)) if font_id<len(fonts) else False
                    v=c.find('m:v',NS);formula=c.find('m:f',NS);kind=c.get('t','n')
                    if kind=='s':
                        text,runs,active=rich(strings[int(v.text)],strike)
                    elif kind=='inlineStr':text,runs,active=rich(c.find('m:is',NS),strike)
                    else:
                        text='' if v is None else v.text or '';runs=[];active='' if strike else text
                    if text or formula is not None:
                        cells.append({'address':c.get('r'),'row':int(row.get('r','0')),'type':kind,'text':text,
                                      'richText':runs,'strike':strike,'activeText':active,'hiddenRow':row.get('hidden')=='1',
                                      'formula':None if formula is None else formula.text or '',
                                      'formulaAttributes':None if formula is None else dict(formula.attrib),
                                      'cachedFormulaValue':formula is not None})
            # Shared-formula indices may be renumbered by an exporter without
            # changing any expression. Compare their semantic base, not `si`.
            shared_bases={c['formulaAttributes'].get('si'):{'anchor':c['address'],'expression':c['formula'],'ref':c['formulaAttributes'].get('ref')}
                          for c in cells if c['formulaAttributes'] and c['formulaAttributes'].get('t')=='shared' and c['formula']}
            for c in cells:
                attrs=c['formulaAttributes']
                c['formulaContext']=None if attrs is None else {'attributes':{k:v for k,v in attrs.items() if k!='si'}}
                if attrs and attrs.get('t')=='shared':c['formulaContext']['sharedBase']=shared_bases.get(attrs.get('si'))
            hyperlinks=[]
            for h in body.findall('m:hyperlinks/m:hyperlink',NS):
                rel=links.get(h.get('{'+R+'}id'),{})
                hyperlinks.append({'ref':h.get('ref'),'location':h.get('location'),'display':h.get('display'),
                                   'target':rel.get('Target'),'targetMode':rel.get('TargetMode'),'followed':False})
            sheets.append({'name':sheet.get('name'),'state':sheet.get('state','visible'),
                           'merges':[m.get('ref') for m in body.findall('m:mergeCells/m:mergeCell',NS)],
                           'hiddenColumns':[dict(c.attrib) for c in body.findall('m:cols/m:col',NS) if c.get('hidden')=='1'],
                           'hyperlinks':hyperlinks,'cells':cells})
        result={'source':str(path),'bytes':path.stat().st_size,'sha256':before,'readOnly':True,
                'worksheetPathsUsed':False,'sheets':sheets,'embeddedMediaCount':sum(n.startswith('xl/media/') for n in names)}
    if sha(path)!=before:raise ValueError('Input changed during extraction; stop and use a stable read-only copy')
    return result

def compare(old,new):
    a={s['name']:s for s in old['sheets']};b={s['name']:s for s in new['sheets']};changes=[]
    for name in dict.fromkeys([*a,*b]):
        x={c['address']:c for c in a.get(name,{}).get('cells',[])}
        y={c['address']:c for c in b.get(name,{}).get('cells',[])}
        def key(addr):
            match=re.fullmatch(r'([A-Z]+)(\d+)',addr)
            if not match:return (0,addr)
            col=0
            for ch in match[1]:col=col*26+ord(ch)-64
            return (int(match[2]),col)
        if name not in a or name not in b:changes.append({'sheet':name,'scope':'sheet','change':'added' if name not in a else 'deleted'})
        for address in sorted(set(x)|set(y),key=key):
            before=x.get(address);after=y.get(address)
            fields=['text','activeText','strike','formula','formulaContext','hiddenRow']
            if before is None or after is None or any(before.get(k)!=after.get(k) for k in fields):
                changes.append({'sheet':name,'cell':address,'change':'added' if before is None else 'deleted' if after is None else 'changed','before':before,'after':after})
    return {'previousSha256':old['sha256'],'latestSha256':new['sha256'],'changes':changes}

def extract(input_file,output,previous=None):
    output=Path(output).resolve()
    if output.exists():raise FileExistsError('Output exists; input and previous outputs are never overwritten')
    current=read_book(input_file)
    result=current if previous is None else {'latest':current,'diff':compare(read_book(previous),current)}
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('x',encoding='utf8') as f:json.dump(result,f,ensure_ascii=False,indent=2)
    return result

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',required=True);p.add_argument('--out',required=True);p.add_argument('--previous');a=p.parse_args()
    data=extract(a.input,a.out,a.previous);book=data.get('latest',data)
    print(json.dumps({'sha256':book['sha256'],'sheets':len(book['sheets']),'readOnly':True,'photoshopCalled':False,'changes':len(data.get('diff',{}).get('changes',[]))}))
