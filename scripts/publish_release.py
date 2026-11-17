#!/usr/bin/env python3
"""Публикует последнюю успешную сборку (IPA + APK) как релиз в публичный репозиторий.

Использование:
    python3 scripts/publish_release.py                 # заметки по умолчанию
    python3 scripts/publish_release.py "Что нового"    # свои заметки
    python3 scripts/publish_release.py --private ...   # дополнительно и в приватный репо

Версия берётся из app.json.
"""
import base64
import datetime
import io
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile

BUILD_REPO = 'woutype/WouFY.no'
PUBLIC_REPO = 'woutype/WouFY-source'
WORKFLOW = 'build.yml'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_token():
    token = os.environ.get('GITHUB_TOKEN')
    if token:
        return token
    p = subprocess.Popen(['git', 'credential', 'fill'], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, _ = p.communicate(f'url=https://github.com/{BUILD_REPO}.git\n\n')
    creds = dict(l.split('=', 1) for l in out.strip().split('\n') if '=' in l)
    return creds.get('password', '')


TOKEN = get_token()
if not TOKEN:
    sys.exit('❌ Нет GitHub токена (задайте GITHUB_TOKEN или настройте git credential)')
HEADERS = {'Authorization': f'Bearer {TOKEN}', 'Accept': 'application/vnd.github+json'}


def api(method, url, data=None, headers=None, raw=False):
    body = json.dumps(data).encode() if isinstance(data, (dict, list)) else data
    req = urllib.request.Request(url, data=body, method=method, headers=headers or HEADERS)
    with urllib.request.urlopen(req) as r:
        payload = r.read()
        return payload if raw else (json.loads(payload) if payload else {})


def wait_for_build():
    url = f'https://api.github.com/repos/{BUILD_REPO}/actions/workflows/{WORKFLOW}/runs?branch=main&per_page=1'
    started = time.time()
    while True:
        runs = api('GET', url).get('workflow_runs', [])
        if not runs:
            sys.exit('❌ Не найдено запусков сборки')
        run = runs[0]
        if run['status'] == 'completed':
            if run['conclusion'] != 'success':
                sys.exit(f"❌ Последняя сборка: {run['conclusion']} -> {run['html_url']}")
            print(f"✅ Сборка успешна: {run['html_url']}")
            return run
        print(f"\r⏳ Сборка идёт ({run['status']}), {int(time.time() - started)}с...", end='', flush=True)
        time.sleep(15)


def fetch_artifact(run_id, name, ext):
    arts = api('GET', f'https://api.github.com/repos/{BUILD_REPO}/actions/runs/{run_id}/artifacts')['artifacts']
    art = next((a for a in arts if a['name'] == name), None)
    if not art:
        sys.exit(f'❌ В сборке нет артефакта {name}')

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    req = urllib.request.Request(
        f"https://api.github.com/repos/{BUILD_REPO}/actions/artifacts/{art['id']}/zip", headers=HEADERS)
    try:
        data = urllib.request.build_opener(NoRedirect).open(req).read()
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307):
            raise
        data = urllib.request.urlopen(e.headers['Location']).read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        member = next(n for n in z.namelist() if n.endswith(ext))
        return z.read(member)


def get_or_create_release(repo, tag, name, body):
    try:
        rel = api('GET', f'https://api.github.com/repos/{repo}/releases/tags/{tag}')
        api('PATCH', f"https://api.github.com/repos/{repo}/releases/{rel['id']}", {'name': name, 'body': body})
        return rel
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
    return api('POST', f'https://api.github.com/repos/{repo}/releases',
               {'tag_name': tag, 'name': name, 'body': body})


def upload(repo, rel, asset_name, content):
    for a in api('GET', f"https://api.github.com/repos/{repo}/releases/{rel['id']}/assets"):
        if a['name'] == asset_name:
            api('DELETE', f"https://api.github.com/repos/{repo}/releases/assets/{a['id']}")
    h = {'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/octet-stream'}
    res = api('POST', f"https://uploads.github.com/repos/{repo}/releases/{rel['id']}/assets?name={asset_name}",
              content, h)
    print(f"  ⬆️  {repo}: {res['browser_download_url']}")


def update_apps_json(version, notes, ipa_size):
    url = f'https://api.github.com/repos/{PUBLIC_REPO}/contents/apps.json'
    cur = api('GET', url)
    data = json.loads(base64.b64decode(cur['content']))
    entry = {
        'version': version,
        'date': datetime.datetime.now(datetime.timezone.utc).date().isoformat(),
        'downloadURL': f'https://github.com/{PUBLIC_REPO}/releases/download/v{version}/woufy.ipa',
        'apkDownloadURL': f'https://github.com/{PUBLIC_REPO}/releases/download/v{version}/woufy.apk',
        'localizedDescription': notes,
        'size': ipa_size,
    }
    versions = [v for v in data['apps'][0]['versions'] if v.get('version') != version]
    data['apps'][0]['versions'] = [entry] + versions
    text = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    api('PUT', url, {'message': f'release: v{version}',
                     'content': base64.b64encode(text.encode()).decode(), 'sha': cur['sha']})
    with open(os.path.join(ROOT, 'apps.json'), 'w', encoding='utf-8') as f:
        f.write(text)
    print('  📝 apps.json обновлён')


def main():
    args = [a for a in sys.argv[1:] if a != '--private']
    also_private = '--private' in sys.argv
    with open(os.path.join(ROOT, 'app.json'), encoding='utf-8') as f:
        version = json.load(f)['expo']['version']
    tag = f'v{version}'
    notes = args[0] if args else f'WouFY {tag}'

    run = wait_for_build()
    print('⬇️  Скачиваю артефакты...')
    ipa = fetch_artifact(run['id'], 'woufy-ipa', '.ipa')
    apk = fetch_artifact(run['id'], 'woufy-apk', '.apk')
    print(f'📦 IPA {len(ipa) / 1e6:.1f} МБ, APK {len(apk) / 1e6:.1f} МБ')

    repos = [PUBLIC_REPO] + ([BUILD_REPO] if also_private else [])
    for repo in repos:
        print(f'🚀 Релиз {tag} -> {repo}')
        rel = get_or_create_release(repo, tag, f'WouFY {tag}', notes)
        upload(repo, rel, 'woufy.ipa', ipa)
        upload(repo, rel, 'woufy.apk', apk)

    update_apps_json(version, notes, len(ipa))
    print(f'🎉 Готово: https://github.com/{PUBLIC_REPO}/releases/tag/{tag}')


if __name__ == '__main__':
    main()
