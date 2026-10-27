"""Shared settings of the browser suite: addresses, the server password,
readiness, and what the page requested."""
import os
import time
from urllib.parse import urlparse

import pytest
import requests

PROXY_URL = os.environ.get("PROXY_URL", "http://proxy:8080").rstrip("/")
PREFIX = os.environ.get("PREFIX", "/opencode")
ROOT_URL = os.environ.get("ROOT_URL", "http://opencode-sandbox:4096").rstrip("/")
PASSWORD = os.environ["OPENCODE_E2E_SERVER_PASSWORD"]
AUTH = ("opencode", PASSWORD)
APP = PROXY_URL + PREFIX + "/"

# every root-absolute URL the rendered document names, in any element
ROOT_ABSOLUTE_URLS = """() => [...document.querySelectorAll('[src],[href],[action]')]
    .flatMap(element => ['src', 'href', 'action'].map(name => element.getAttribute(name)))
    .filter(value => value && value.startsWith('/') && !value.startsWith('//'))"""


def wait_for(url, timeout=300):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            response = requests.get(url, auth=AUTH, timeout=5)
            if response.status_code == 200 and response.json().get("healthy") is True:
                return
            last = f"status {response.status_code}: {response.text[:200]}"
        except (requests.RequestException, ValueError) as error:
            last = error
        time.sleep(2)
    raise TimeoutError(f"{url} did not report healthy within {timeout}s: {last}")


def below(url, prefix=PREFIX):
    path = urlparse(url).path
    return path == prefix or path.startswith(prefix + "/")


def own(urls, origin):
    netloc = urlparse(origin).netloc
    return [url for url in urls if urlparse(url).scheme in ("http", "https", "ws", "wss") and urlparse(url).netloc == netloc]


def outside(urls, origin=PROXY_URL):
    return [url for url in own(urls, origin) if not below(url)]


def record(page):
    """Every request, websocket and answer of the page, from now on; an answer
    as its status and content type."""
    requested, responses = [], {}
    page.on("request", lambda request: requested.append(request.url))
    page.on("websocket", lambda websocket: requested.append(websocket.url))
    page.on("response", lambda response: responses.__setitem__(
        response.url, (response.status, response.headers.get("content-type", ""))))
    return requested, responses


def settled(page, requested, timeout=60):
    """The page has drawn the interface, and neither its address nor the
    number of its requests changed over four samples half a second apart. The
    event stream stays open, so the page never becomes idle on the network."""
    page.wait_for_function("document.getElementById('root') && document.getElementById('root').children.length > 0",
                           timeout=timeout * 1000)
    deadline = time.time() + timeout
    samples = []
    while time.time() < deadline:
        samples = (samples + [(page.evaluate("location.pathname"), len(requested))])[-4:]
        if len(samples) == 4 and len(set(samples)) == 1:
            return samples[0][0]
        page.wait_for_timeout(500)
    raise TimeoutError(f"the page did not settle within {timeout}s: {samples}")


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args):
    # the server password, as the browser asks for it at the challenge of OpenCode
    return {**browser_context_args, "http_credentials": {"username": AUTH[0], "password": AUTH[1]}}


@pytest.fixture(scope="session", autouse=True)
def services_ready():
    wait_for(PROXY_URL + PREFIX + "/global/health")
    wait_for(ROOT_URL + "/global/health")
