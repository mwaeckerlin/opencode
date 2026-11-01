"""The link to the login page of the LiteLLM subscriptions, at the root of
the image and below the base path /opencode behind Traefik, in Chromium and
Firefox."""
import os

import pytest
from playwright.sync_api import Page

from conftest import APP, SUBSCRIPTION_URL, record, settled, wait_for

LOGIN_URL = os.environ.get("LOGIN_URL", "http://proxy:8080/litellm/mysubs")

# every control of the interface whose box the link would cover
CONTROLS_UNDER_THE_LINK = """() => {
    const link = document.getElementById('litellm-subscription-login').getBoundingClientRect()
    return [...document.querySelectorAll('#root button, #root a, #root input, #root textarea, #root select, #root [role=button], #root [contenteditable]')]
        .filter(element => element.offsetParent !== null || getComputedStyle(element).position === 'fixed')
        .map(element => [element, element.getBoundingClientRect()])
        .filter(([, box]) => box.width > 0 && box.height > 0
            && box.left < link.right && box.right > link.left && box.top < link.bottom && box.bottom > link.top)
        .map(([element]) => element.outerHTML.slice(0, 120))
}"""


@pytest.fixture(scope="module", autouse=True)
def subscription_ready():
    wait_for(SUBSCRIPTION_URL + "/global/health")


def violations(page):
    """Every message of the browser about a refused resource of the page."""
    found = []
    page.on("console", lambda message: found.append(message.text)
            if "Content Security Policy" in message.text or "Content-Security-Policy" in message.text else None)
    return found


def check_link(page: Page, url):
    refused = violations(page)
    requested, responses = record(page)
    page.goto(url)
    settled(page, requested)
    link = page.locator("#litellm-subscription-login")
    assert link.is_visible()
    assert link.inner_text() == "Subscription login"
    assert link.get_attribute("href") == LOGIN_URL
    assert link.get_attribute("target") == "_blank"
    assert "noopener" in link.get_attribute("rel")
    # the stylesheet of the link comes from the origin of the page and applies
    styles = {address: status for address, (status, _) in responses.items() if address.endswith("/opencode-login-link.css")}
    assert list(styles.values()) == [200], responses
    box = link.bounding_box()
    viewport = page.viewport_size
    assert box and box["x"] >= 0 and box["y"] >= 0, box
    assert box["x"] + box["width"] <= viewport["width"] and box["y"] + box["height"] <= viewport["height"], (box, viewport)
    # the bar stands above the interface, which fills the rest of the window
    # to its bottom edge, so the link covers nothing and nothing is cut off
    bar = page.locator("#litellm-subscription-bar").bounding_box()
    root = page.locator("#root").bounding_box()
    assert bar["y"] == 0 and bar["height"] > 0, bar
    assert abs(root["y"] - bar["height"]) < 1, (bar, root)
    assert abs(root["y"] + root["height"] - viewport["height"]) < 1, (root, viewport)
    assert page.evaluate("document.scrollingElement.scrollHeight") <= viewport["height"]
    assert page.evaluate(CONTROLS_UNDER_THE_LINK) == []
    assert not refused, refused
    # the link opens the login page in a window of its own
    with page.context.expect_page() as opened:
        link.click()
    assert opened.value.url == LOGIN_URL


def test_login_link_at_the_root(page: Page):
    check_link(page, SUBSCRIPTION_URL + "/")


def test_login_link_below_the_base_path_keeps_its_address(page: Page):
    # the login page lies on the origin of the proxy, outside /opencode; the
    # browser script leaves its address as it is
    check_link(page, APP)
    assert page.evaluate("globalThis.__opencodeBasePath") == "/opencode"


def test_login_link_stays_in_the_window_on_a_phone(page: Page):
    page.set_viewport_size({"width": 360, "height": 640})
    check_link(page, SUBSCRIPTION_URL + "/")


def test_login_link_covers_no_tab_of_a_session(page: Page):
    # the view of a session carries the tab strip of the interface at the top
    page.set_viewport_size({"width": 390, "height": 844})
    check_link(page, SUBSCRIPTION_URL + "/L3dvcmtzcGFjZQ/session")
