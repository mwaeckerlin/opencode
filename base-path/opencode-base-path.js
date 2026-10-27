// Loaded by the page below a base path, before the OpenCode bundle; the front
// process (serve.mjs) writes it as the first script of the head and serves it
// at <base path>/opencode-base-path.js, which gives the script its base path.
//
// The interface addresses its server through the origin of the page
// (`location.origin + "/session"`, `/global/event`, `/pty/…`) and names
// workers and pictures root-absolute (`/assets/…`). This script puts the base
// path in front of every root-absolute URL of this origin the page requests:
// fetch, XMLHttpRequest, WebSocket, EventSource, workers, the service worker,
// window.open, sendBeacon, the history, the src, href and action of every
// element, and a document navigation. A relative, foreign or already prefixed
// URL stays as it is. The router of the bundle reads the base path from
// globalThis.__opencodeBasePath (patch-upstream.mjs).
(function () {
  "use strict";
  var script = document.currentScript;
  var own = "/opencode-base-path.js";
  var path = script ? new URL(script.src, location.href).pathname : "";
  var base = path.slice(-own.length) === own ? path.slice(0, -own.length).replace(/\/+$/, "") : "";
  if (!base) return;
  globalThis.__opencodeBasePath = base;
  var prefix = base + "/";
  var origins = [location.origin, location.origin.replace(/^http/, "ws")];

  function rebasePath(path) {
    if (path === base || path.indexOf(prefix) === 0) return path;
    var next = path.charAt(base.length);
    if (path.indexOf(base) === 0 && (next === "?" || next === "#")) return path;
    return base + path;
  }

  function rebase(value) {
    if (value instanceof URL) {
      var href = rebase(value.href);
      return href === value.href ? value : new URL(href);
    }
    if (typeof value !== "string") return value;
    if (value.charAt(0) === "/") {
      var second = value.charAt(1);
      return second === "/" || second === "\\" ? value : rebasePath(value);
    }
    for (var i = 0; i < origins.length; i++) {
      var origin = origins[i];
      if (value.slice(0, origin.length + 1).toLowerCase() === (origin + "/").toLowerCase()) {
        return value.slice(0, origin.length) + rebasePath(value.slice(origin.length));
      }
    }
    return value;
  }
  globalThis.__opencodeRebase = rebase;

  var slice = Array.prototype.slice;

  var nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof Request !== "undefined" && input instanceof Request) {
      var target = rebase(input.url);
      if (target !== input.url) input = new Request(target, input);
      return nativeFetch.call(window, input, init);
    }
    return nativeFetch.call(window, rebase(input), init);
  };

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () {
    var args = slice.call(arguments);
    args[1] = rebase(args[1]);
    return nativeOpen.apply(this, args);
  };

  ["WebSocket", "EventSource", "Worker", "SharedWorker"].forEach(function (name) {
    var Native = window[name];
    if (typeof Native !== "function") return;
    var Rebased = function () {
      var args = slice.call(arguments);
      args[0] = rebase(args[0]);
      return Reflect.construct(Native, args, new.target || Native);
    };
    Rebased.prototype = Native.prototype;
    Object.setPrototypeOf(Rebased, Native);
    window[name] = Rebased;
  });

  var nativeWindowOpen = window.open;
  window.open = function () {
    var args = slice.call(arguments);
    args[0] = rebase(args[0]);
    return nativeWindowOpen.apply(this, args);
  };

  if (navigator.sendBeacon) {
    var nativeSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function (url, data) {
      return nativeSendBeacon.call(navigator, rebase(url), data);
    };
  }

  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    var container = navigator.serviceWorker;
    var nativeRegister = container.register;
    container.register = function (url, options) {
      var rebasedOptions = options ? Object.assign({}, options) : undefined;
      if (rebasedOptions && rebasedOptions.scope) rebasedOptions.scope = rebase(rebasedOptions.scope);
      return nativeRegister.call(container, rebase(url), rebasedOptions);
    };
  }

  ["pushState", "replaceState"].forEach(function (name) {
    var native = History.prototype[name];
    History.prototype[name] = function () {
      var args = slice.call(arguments);
      if (args.length > 2 && args[2] !== undefined && args[2] !== null) args[2] = rebase(args[2]);
      return native.apply(this, args);
    };
  });

  // Element URLs: Solid writes src and href through setAttribute or through
  // the property, so both carry the base path; an SVG <use> names its sprite
  // through href as well.
  var URL_ATTRIBUTES = { src: true, href: true, "xlink:href": true, poster: true, action: true, formaction: true };
  var nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (URL_ATTRIBUTES[String(name).toLowerCase()] && typeof value === "string") value = rebase(value);
    return nativeSetAttribute.call(this, name, value);
  };
  var nativeSetAttributeNS = Element.prototype.setAttributeNS;
  Element.prototype.setAttributeNS = function (namespace, name, value) {
    if (URL_ATTRIBUTES[String(name).toLowerCase()] && typeof value === "string") value = rebase(value);
    return nativeSetAttributeNS.call(this, namespace, name, value);
  };
  [
    ["HTMLImageElement", "src"], ["HTMLMediaElement", "src"], ["HTMLSourceElement", "src"],
    ["HTMLScriptElement", "src"], ["HTMLIFrameElement", "src"], ["HTMLTrackElement", "src"],
    ["HTMLEmbedElement", "src"], ["HTMLInputElement", "src"], ["HTMLVideoElement", "poster"],
    ["HTMLAnchorElement", "href"], ["HTMLAreaElement", "href"], ["HTMLLinkElement", "href"],
    ["HTMLFormElement", "action"], ["HTMLButtonElement", "formAction"], ["HTMLInputElement", "formAction"],
  ].forEach(function (entry) {
    var Type = window[entry[0]];
    if (!Type) return;
    var descriptor = Object.getOwnPropertyDescriptor(Type.prototype, entry[1]);
    if (!descriptor || !descriptor.set) return;
    Object.defineProperty(Type.prototype, entry[1], {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set: function (value) { descriptor.set.call(this, typeof value === "string" ? rebase(value) : value); },
    });
  });

  // A document navigation to a root-absolute address of this origin, such as
  // `location.href = "/session"`, which no setter above sees: where the
  // browser has the Navigation API, it goes to the same address below the
  // base path.
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("navigate", function (event) {
      if (!event.cancelable || event.navigationType === "traverse" || event.hashChange) return;
      if (event.downloadRequest != null || event.formData) return;
      var url = new URL(event.destination.url);
      if (url.origin !== location.origin) return;
      var path = rebasePath(url.pathname);
      if (path === url.pathname) return;
      event.preventDefault();
      location.assign(path + url.search + url.hash);
    });
  }

  // Elements of the page and of the templates the bundle clones: an element
  // that arrives with a root-absolute URL gets the base path.
  var NAMES = ["src", "href", "poster", "action", "formaction"];
  function rebaseElement(element) {
    for (var i = 0; i < NAMES.length; i++) {
      var value = element.getAttribute(NAMES[i]);
      if (value !== null && rebase(value) !== value) nativeSetAttribute.call(element, NAMES[i], rebase(value));
    }
    var xlink = element.getAttributeNS && element.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    if (xlink && rebase(xlink) !== xlink) nativeSetAttributeNS.call(element, "http://www.w3.org/1999/xlink", "xlink:href", rebase(xlink));
  }
  function rebaseTree(root) {
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) rebaseElement(root);
    var elements = root.querySelectorAll("[src],[href],[poster],[action],[formaction]");
    for (var i = 0; i < elements.length; i++) rebaseElement(elements[i]);
  }
  rebaseTree(document);
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      for (var j = 0; j < records[i].addedNodes.length; j++) rebaseTree(records[i].addedNodes[j]);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", function () { rebaseTree(document); });
})();
