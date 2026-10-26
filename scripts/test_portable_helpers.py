"""Offline contracts: readonly OOXML extraction, strike scope, safe plans."""
import json,tempfile,unittest,zipfile
from pathlib import Path
from read_workbook import read_book,extract,compare,sha
from create_probe_plan import create

M='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P='http://schemas.openxmlformats.org/package/2006/relationships'
def workbook(path,deleted=False,rich=True,external=False,shared_index=None):
    names=['需求']+(['删掉的页'] if deleted else [])
    with zipfile.ZipFile(path,'x') as z:
        z.writestr('xl/workbook.xml',f'<workbook xmlns="{M}" xmlns:r="{R}"><sheets>'+''.join(f'<sheet name="{n}" sheetId="{i}" r:id="r{i}"/>' for i,n in enumerate(names,1))+'</sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels',f'<Relationships xmlns="{P}">'+''.join(f'<Relationship Id="r{i}" Target="worksheets/s{i}.xml"'+(' TargetMode="External"' if external else '')+'/>' for i in range(1,len(names)+1))+'</Relationships>')
        for i in range(1,len(names)+1):
            value='<r><rPr><strike/></rPr><t>20日</t></r><r><t>24日</t></r>' if rich else '<t>24日</t>'
            shared='' if shared_index is None else f'<c r="C1"><f t="shared" ref="C1:D1" si="{shared_index}">A1</f><v>1</v></c><c r="D1"><f t="shared" si="{shared_index}"/><v>1</v></c>'
            z.writestr(f'xl/worksheets/s{i}.xml',f'<worksheet xmlns="{M}" xmlns:r="{R}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is>{value}</is></c><c r="B1"><f>HYPERLINK("https://invalid.example","data")</f><v>841</v></c>{shared}</row></sheetData><mergeCells><mergeCell ref="A1:A2"/></mergeCells></worksheet>')

class Contracts(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
    def test_source_unchanged_and_formula_inert(self):
        p=self.root/'book.xlsx';workbook(p);before=sha(p);data=extract(p,self.root/'out.json')
        self.assertEqual(before,sha(p));a,b=data['sheets'][0]['cells'];self.assertEqual(a['text'],'20日24日');self.assertEqual(a['activeText'],'24日');self.assertTrue(b['cachedFormulaValue']);self.assertEqual(b['text'],'841');self.assertEqual(data['sheets'][0]['merges'],['A1:A2'])
    def test_preexisting_output_or_input_cannot_be_overwritten(self):
        p=self.root/'book.xlsx';workbook(p);out=self.root/'out.json';extract(p,out);old=out.read_bytes()
        with self.assertRaises(FileExistsError):extract(p,out)
        with self.assertRaises(FileExistsError):extract(p,p)
        self.assertEqual(old,out.read_bytes())
    def test_strike_change_and_removed_sheet_retained_in_diff(self):
        old=self.root/'old.xlsx';new=self.root/'new.xlsx';workbook(old,deleted=True);workbook(new,rich=False)
        changes=compare(read_book(old),read_book(new))['changes'];self.assertTrue(any(x.get('cell')=='A1' and x['change']=='changed' for x in changes));self.assertTrue(any(x.get('scope')=='sheet' and x['change']=='deleted' for x in changes))
    def test_external_sheet_does_not_fetch_network(self):
        p=self.root/'bad.xlsx';workbook(p,external=True)
        with self.assertRaisesRegex(ValueError,'External worksheet'):read_book(p)
    def test_shared_formula_reindexing_is_not_a_business_change(self):
        old=self.root/'old.xlsx';new=self.root/'new.xlsx';workbook(old,shared_index=0);workbook(new,shared_index=5)
        self.assertEqual(compare(read_book(old),read_book(new))['changes'],[])
    def test_probe_generates_only_data_and_refuses_replay(self):
        plan=create(self.root,'ArialMT');self.assertEqual(json.loads(plan.read_text('utf8'))['kind'],'compose');self.assertFalse(list(plan.parent.glob('*.psd')));self.assertFalse((plan.parent/'receipt.json').exists())
        with self.assertRaises(FileExistsError):create(self.root,'ArialMT')
        with self.assertRaises(ValueError):create(self.root,'ArialMT','../escape')
    def test_whole_cell_strike_with_run_override(self):
        from read_workbook import rich
        import xml.etree.ElementTree as E
        e=E.fromstring(f'<is xmlns="{M}"><r><rPr><strike val="0"/></rPr><t>keep</t></r><r><t>cancel</t></r></is>')
        self.assertEqual(rich(e,True)[2],'keep')

if __name__=='__main__':unittest.main()
