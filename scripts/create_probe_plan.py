"""Create JSON only; no synthetic PSD or fake Photoshop receipt."""
import argparse,json
from pathlib import Path

def create(workspace,font,run='interface-probe'):
    workspace=Path(workspace).resolve()
    if not run or Path(run).name!=run or '/' in run or '\\' in run or run in ['.','..']:
        raise ValueError('run must be a plain new directory name')
    folder=workspace/'runs'/run
    folder.mkdir(parents=True,exist_ok=False)
    plan={'kind':'compose','name':'Interface probe — not a product delivery','width':1440,'height':1440,
          'psd':str(folder/'probe.psd'),'png':str(folder/'probe.png'),'sourceCells':[],
          'groupOrder':['background','text'],'layers':[
              {'type':'rect','name':'paper','group':'background','x':0,'y':0,'width':1440,'height':1440,'color':'F3F0EC'},
              {'type':'text','name':'probe-title','group':'text','text':'PHOTOSHOP INTERFACE PROBE','font':font,'size':52,'x':72,'y':170,'color':'211D24','maxWidth':1296},
              {'type':'text','name':'probe-note','group':'text','text':'Not a product delivery','font':font,'size':30,'x':72,'y':250,'color':'783F57'}]}
    (folder/'plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2),'utf8')
    (folder/'args.json').write_text(json.dumps({'path':str(folder/'plan.json')},indent=2),'utf8')
    return folder/'plan.json'

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--workspace',required=True);p.add_argument('--font',required=True);p.add_argument('--run',default='interface-probe');a=p.parse_args()
    print(create(a.workspace,a.font,a.run))
