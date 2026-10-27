"""OpenCode below the base path /opencode, behind Traefik with
PathPrefix(`/opencode`) and without StripPrefix, in Chromium."""
import json
import socket
from urllib.parse import urlparse

import requests
from playwright.sync_api import Page

from conftest import APP, AUTH, PREFIX, PROXY_URL, ROOT_ABSOLUTE_URLS, ROOT_URL, below, own, outside, record, settled


def test_bare_base_path_redirects_to_its_slash_form():
    for request, location in ((PREFIX, PREFIX + "/"), (PREFIX + "?x=%2F", PREFIX + "/?x=%2F")):
        response = requests.get(PROXY_URL + request, auth=AUTH, allow_redirects=False, timeout=10)
        assert response.status_code == 308, response.status_code
        assert response.headers["Location"] == location


def test_the_page_names_its_files_below_the_base_path():
    html = requests.get(APP, auth=AUTH, timeout=10).text
    assert f'<script src="{PREFIX}/opencode-base-path.js"></script>' in html
    assert html.index("opencode-base-path.js") < html.index('type="module"')
    assert f'src="{PREFIX}/assets/' in html
    assert f'href="{PREFIX}/favicon' in html
    assert 'src="/assets/' not in html and 'href="/assets/' not in html


def test_nothing_outside_the_base_path_is_routed():
    assert requests.get(PROXY_URL + "/global/health", auth=AUTH, timeout=10).status_code == 404


def test_the_server_password_holds_below_the_base_path():
    assert requests.get(APP, timeout=10).status_code == 401
    assert requests.get(PROXY_URL + PREFIX + "/global/health", timeout=10).status_code == 401


def test_page_renders_and_every_request_stays_below_the_base_path(page: Page):
    requested, responses = record(page)
    page.goto(APP)
    settled(page, requested)
    assert page.title() == "OpenCode"
    assert own(requested, PROXY_URL), "the page made no request to its own server"
    assert not outside(requested), f"requests left {PREFIX}: {outside(requested)}"
    files = {url: answer for url, answer in responses.items() if below(url, PREFIX + "/assets")}
    assert any(urlparse(url).path.endswith(".js") and status == 200 for url, (status, _) in files.items()), responses
    assert any(urlparse(url).path.endswith(".css") and status == 200 for url, (status, _) in files.items()), responses
    failed = {url: status for url, (status, _) in responses.items() if below(url) and status >= 400}
    assert not failed, f"requests failed below {PREFIX}: {failed}"
    # the interface talks to the server API below the base path
    api = [url for url, (status, kind) in responses.items()
           if below(url) and status == 200 and ("json" in kind or "event-stream" in kind)]
    assert api, f"no API answer below {PREFIX}: {responses}"


def test_the_router_lands_where_it_lands_at_the_root(page: Page):
    requested, _ = record(page)
    page.goto(ROOT_URL + "/")
    at_root = settled(page, requested)
    title = page.title()
    requested.clear()
    page.goto(APP)
    below_base = settled(page, requested)
    assert below_base == PREFIX + at_root, (below_base, at_root)
    assert page.title() == title


def test_document_names_no_url_outside_the_base_path(page: Page):
    requested, _ = record(page)
    page.goto(APP)
    settled(page, requested)
    named = [url for url in page.evaluate(ROOT_ABSOLUTE_URLS) if not below(url)]
    assert not named, f"the page names URLs outside {PREFIX}: {named}"


def test_deep_link_serves_the_page_below_the_base_path():
    deep = requests.get(APP + "L3dvcmtzcGFjZQ/session", auth=AUTH, timeout=10)
    assert deep.status_code == 200
    assert f'src="{PREFIX}/assets/' in deep.text
    assert f'<script src="{PREFIX}/opencode-base-path.js"></script>' in deep.text


def test_stylesheet_and_manifest_name_their_files_below_the_base_path():
    html = requests.get(APP, auth=AUTH, timeout=10).text
    stylesheet = html.split('rel="stylesheet"', 1)[1].split('href="', 1)[1].split('"', 1)[0]
    css = requests.get(PROXY_URL + stylesheet, auth=AUTH, timeout=10).text
    assert f"url({PREFIX}/assets/" in css
    assert "url(/assets/" not in css
    manifest = requests.get(PROXY_URL + PREFIX + "/site.webmanifest", timeout=10).json()
    assert all(icon["src"].startswith("./") for icon in manifest["icons"]), manifest
    assert manifest["start_url"] == "./"


def test_fetch_xhr_and_event_source_of_root_absolute_api_stay_below_the_base_path(page: Page):
    requested, _ = record(page)
    page.goto(APP)
    settled(page, requested)
    results = page.evaluate("""async () => {
        const xhr = await new Promise(resolve => {
            const request = new XMLHttpRequest()
            request.open('GET', '/global/health')
            request.onload = () => resolve(JSON.parse(request.responseText).healthy)
            request.send()
        })
        const source = await new Promise(resolve => {
            const events = new EventSource('/global/event')
            events.onopen = () => { events.close(); resolve(events.url) }
            events.onerror = () => { events.close(); resolve(events.url) }
        })
        return [
            (await fetch('/global/health').then(r => r.json())).healthy,
            (await fetch(new Request('/global/health')).then(r => r.json())).healthy,
            (await fetch(new URL('/global/health', location.origin)).then(r => r.json())).healthy,
            (await fetch(location.origin + '/global/health').then(r => r.json())).healthy,
            xhr,
            source,
        ]
    }""")
    assert results[:5] == [True] * 5, results
    assert below(results[5]), results[5]
    health = [url for url in requested if urlparse(url).path.endswith("/global/health")]
    assert health and all(below(url) for url in health), health
    assert any(urlparse(url).path == PREFIX + "/global/event" for url in requested), requested


def test_websocket_of_the_page_opens_below_the_base_path(page: Page):
    requested, _ = record(page)
    page.goto(APP)
    settled(page, requested)
    url = page.evaluate("""() => new Promise(resolve => {
        const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/pty/e2e/connect')
        socket.onopen = () => { socket.close(); resolve(socket.url) }
        socket.onerror = () => resolve(socket.url)
    })""")
    assert below(url), url
    sockets = [entry for entry in requested if urlparse(entry).scheme in ("ws", "wss")]
    assert sockets and all(below(entry) for entry in sockets), sockets


def upgrade(path):
    """The head of the answer to a websocket upgrade through the proxy, without the password."""
    target = urlparse(PROXY_URL)
    with socket.create_connection((target.hostname, target.port), timeout=10) as connection:
        connection.sendall((f"GET {path} HTTP/1.1\r\nHost: {target.netloc}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
                            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").encode())
        answer = b""
        while b"\r\n\r\n" not in answer and (chunk := connection.recv(4096)):
            answer += chunk
    return answer.partition(b"\r\n\r\n")[0].decode(errors="replace")


def test_websocket_upgrade_reaches_opencode_only_below_the_base_path():
    # OpenCode asks for its password; the proxy has no route outside the base path
    answer = upgrade(PREFIX + "/pty/e2e/connect")
    assert answer.startswith("HTTP/1.1 401"), answer
    assert 'basic realm="secure area"' in answer.lower(), answer
    assert upgrade("/pty/e2e/connect").startswith("HTTP/1.1 404")


def test_links_history_and_windows_keep_the_base_path(page: Page):
    requested, _ = record(page)
    page.goto(APP)
    settled(page, requested)
    results = page.evaluate("""() => {
        const link = document.createElement('a')
        link.href = '/L3dvcmtzcGFjZQ/session'
        const attribute = document.createElement('a')
        attribute.setAttribute('href', '/assets/x.png')
        const image = new Image()
        image.src = '/assets/x.svg'
        const pushed = (history.pushState(null, '', '/L3dvcmtzcGFjZQ/session'), location.pathname)
        history.replaceState(null, '', '/')
        return [link.href, attribute.getAttribute('href'), image.src, pushed, location.pathname]
    }""")
    assert results == [APP + "L3dvcmtzcGFjZQ/session", PREFIX + "/assets/x.png", APP + "assets/x.svg",
                       PREFIX + "/L3dvcmtzcGFjZQ/session", PREFIX + "/"], results
    with page.context.expect_page() as popup:
        page.evaluate("window.open('/global/health')")
    popup.value.wait_for_load_state()
    assert popup.value.url == APP + "global/health"
    assert json.loads(popup.value.inner_text("body"))["healthy"] is True


def test_document_navigation_to_a_root_absolute_address_stays_below_the_base_path(page: Page):
    requested, _ = record(page)
    page.goto(APP)
    settled(page, requested)
    page.evaluate("location.href = '/global/health'")
    page.wait_for_url(lambda url: urlparse(url).path == PREFIX + "/global/health", timeout=30000)


def test_foreign_relative_and_prefixed_urls_stay_unchanged(page: Page):
    requested, _ = record(page)
    page.goto(APP)
    settled(page, requested)
    results = page.evaluate(f"""[
        globalThis.__opencodeBasePath,
        globalThis.__opencodeRebase('https://opencode.ai/x'),
        globalThis.__opencodeRebase('//cdn.example.org/x.js'),
        globalThis.__opencodeRebase('{PREFIX}/session'),
        globalThis.__opencodeRebase('relative/path'),
        globalThis.__opencodeRebase('data:image/png;base64,AAAA'),
        globalThis.__opencodeRebase('#section'),
    ]""")
    assert results == [PREFIX, "https://opencode.ai/x", "//cdn.example.org/x.js", f"{PREFIX}/session",
                       "relative/path", "data:image/png;base64,AAAA", "#section"]
