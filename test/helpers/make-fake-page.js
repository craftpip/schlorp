const vm = require("vm");

// Runs a page.evaluate callback against an injected `document`/`window` sandbox.
// The callback is serialized (fn.toString) and executed in a fresh vm context so
// `document.querySelectorAll("script")` style extraction can run without a browser.
function makeFakePage(options = {}) {
  const {
    document,
    window: windowGlobals = {},
    url = "",
    cookies = [],
    html = "",
    fetchHandler,
  } = options;
  return {
    url: () => url,
    cookies: async () => cookies,
    goto: async () => {},
    waitForFunction: async () => true,
    click: async () => {},
    content: async () => html,
    evaluate: async (fn, ...args) => {
      const source = `(${fn.toString()})(${args
        .map((a) => JSON.stringify(a))
        .join(",")});`;
      const sandbox = {
        document,
        window: windowGlobals,
        location: (() => {
          try {
            const u = new URL(url);
            return { href: u.href, pathname: u.pathname };
          } catch {
            return { href: url, pathname: "" };
          }
        })(),
        URL,
      };
      if (fetchHandler) sandbox.fetch = fetchHandler;
      const script = new vm.Script(source);
      const context = vm.createContext(sandbox);
      const value = script.runInContext(context);
      let result = typeof value === "function" ? value() : value;
      result = await result;
      if (result && typeof result === "object") {
        try {
          return structuredClone(result);
        } catch {
          return result;
        }
      }
      return result;
    },
  };
}

module.exports = { makeFakePage };