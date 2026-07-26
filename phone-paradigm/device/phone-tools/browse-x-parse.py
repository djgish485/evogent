import subprocess, re, json, time, os
from evogent_api import ORIGIN as BASE, post_json
HOME=os.path.expanduser("~")
PH=HOME+"/phone-tools/phone.sh"
def see():
    try: return subprocess.run(["bash",PH,"see"],capture_output=True,text=True,timeout=45).stdout
    except: return ""
def scroll():
    try: subprocess.run(["bash",PH,"scroll"],capture_output=True,timeout=20)
    except: pass
tweets={}
TIME=re.compile(r'\s+\d+\s+(?:hours?|hour|minutes?|min|days?|day|seconds?)\s+ago', re.I)
for _ in range(6):
    out=see()
    for m in re.finditer(r'desc="([^"]+?)"', out):
        d=m.group(1)
        hm=re.search(r'@(\w{2,15})', d)
        if not hm: continue
        handle=hm.group(1)
        if handle.lower() in ('home','search','following'): continue
        if 'likes' not in d and 'views' not in d and 'reposts' not in d: continue
        # display name = before @handle ; text = after "@handle [Verified.]" up to the time marker
        name=d[:d.index('@'+handle)].strip().rstrip('▶️ ').strip()
        rest=d[d.index('@'+handle)+len('@'+handle):]
        rest=re.sub(r'^\s*(?:Verified\.)?\s*','',rest)
        tm=TIME.search(rest)
        text=(rest[:tm.start()] if tm else rest).strip()
        text=re.sub(r'\s+',' ',text)
        if len(text)<25: continue
        key=handle+'|'+text[:40]
        if key not in tweets:
            tweets[key]={'handle':handle,'name':name[:60],'text':text[:600]}
    if len(tweets)>=10: break
    scroll(); time.sleep(1.5)
NOW=int(time.time()*1000)
items=[]
for t in list(tweets.values())[:12]:
    h=t['handle']; txt=t['text']
    slug=re.sub(r'[^a-z0-9]+','-','-'.join(txt.lower().split()[:6])).strip('-')
    items.append({"source":"twitter","sourceId":f"phone-twitter-{h.lower()}-{slug}"[:80],
      "title":txt[:80],"authorUsername":h,"authorDisplayName":t['name'],
      "url":f"https://x.com/{h}","fetchedAtMs":NOW,"expiresAtMs":NOW+1209600000,
      "payload":{"type":"tweet","text":txt,"authorUsername":h,"authorDisplayName":t['name'],"url":f"https://x.com/{h}","captureMethod":"phone-background-browse-script"}})
body={"source":"twitter","triggeredBy":"phone-browse-x-script","startedAtMs":NOW,"completedAtMs":NOW,"status":"completed","itemsAdded":len(items),"items":items}
try:
    r=post_json(f"{BASE}/api/internal/browse-cache/submit",json.dumps(body).encode(),timeout=15); print("CACHED",len(items),"tweets; resp",r.status)
except Exception as e: print("SUBMIT_ERR",e,"items",len(items))
for t in list(tweets.values())[:12]: print("  @%s: %s"%(t['handle'],t['text'][:70]))
