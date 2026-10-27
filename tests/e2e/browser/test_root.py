"""The same image without OPENCODE_BASE_PATH: OpenCode at the root, as
upstream serves it, in Chromium."""
from urllib.parse import urlparse

import requests
from playwright.sync_api import Page

from conftest import AUTH, PREFIX, ROOT_ABSOLUTE_URLS, ROOT_URL, own, record, settled


def test_the_page_names_its_files_at_the_root():
    html = requests.get(ROOT_URL + "/", auth=AUTH, timeout=10).text
    assert 'src="/assets/' in html
    assert 'href="/favicon' in html
    assert "opencode-base-path.js" not in html


def test_page_renders_at_the_root(page: Page):
    requested, responses = record(page)
    page.goto(ROOT_URL + "/")
    settled(page, requested)
    assert page.title() == "OpenCode"
    mine = own(requested, ROOT_URL)
    assert mine, "the page made no request to its own server"
    prefixed = [url for url in mine if urlparse(url).path.startswith(PREFIX + "/")]
    assert not prefixed, f"the root asked for {PREFIX}: {prefixed}"
    assets = {url: status for url, (status, _) in responses.items() if urlparse(url).path.startswith("/assets/")}
    assert assets and set(assets.values()) == {200}, f"assets at the root: {assets}"
    named = [url for url in page.evaluate(ROOT_ABSOLUTE_URLS) if url.startswith(PREFIX + "/")]
    assert not named, f"the root page names {named}"
    assert page.evaluate("globalThis.__opencodeBasePath") is None
