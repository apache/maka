import datetime,json,os,pathlib,subprocess,sys,tempfile
out=pathlib.Path('/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/quality-20261017/2413')
name=sys.argv[1]; command=sys.argv[2]; cwd=os.environ.get('MAGPIE_VERIFY_CWD','/private/tmp/magpie-quality-20261017-2413')
env=os.environ.copy()
env.update(GOTOOLCHAIN='auto',GOPATH='/Users/ggbdpq/go',GOMODCACHE='/Users/ggbdpq/go/pkg/mod',GOCACHE='/Users/ggbdpq/Library/Caches/go-build',GOMAXPROCS='2')
with tempfile.TemporaryDirectory(prefix='magpie-quality-2413-home-') as home:
 env.update(HOME=home,USERPROFILE=home,XDG_CONFIG_HOME=home+'/.config',XDG_CACHE_HOME=home+'/.cache',XDG_DATA_HOME=home+'/.local/share',XDG_STATE_HOME=home+'/.local/state',APPDATA=home+'/AppData/Roaming',LOCALAPPDATA=home+'/AppData/Local')
 r=subprocess.run(['bash','-o','pipefail','-c',command],cwd=cwd,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 entry={'name':name,'time_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'cwd':cwd,'command':command,'input':'SQLite fixtures in internal/provider/importapps_test.go; no real credentials; temporary HOME via wrapper and provider TestMain testenv','environment':{k:env[k] for k in ['GOTOOLCHAIN','GOPATH','GOMODCACHE','GOCACHE','GOMAXPROCS']},'output':r.stdout,'exit_status':r.returncode}
 (out/'logs'/f'{name}.txt').write_text(r.stdout)
 (out/'logs'/f'{name}.json').write_text(json.dumps(entry,ensure_ascii=False,indent=2)+'\n')
 print(r.stdout,end=''); print('EXIT_STATUS='+str(r.returncode))
 sys.exit(0)
