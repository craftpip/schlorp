const vm = require("vm");

// Runs a page.evaluate callback against an injected `document`/`window` sandbox.
// The callback is serialized (fn.toString) and executed in a fresh vm context so
// `document.querySelectorAll("script")` style extraction can run without a browser.
function makeFakePage(options = {}) {
  const { document, window: windowGlobals = {}, url = "", cookies = [] } = options;
  return {
    url: () => url,
    cookies: async () => cookies,
    goto: async () => {},
    waitForFunction: async () => true,
    click: async () => {},
    evaluate: async (fn, ...args) => {
      const source = `(${fn.toString()})(${args
        .map((a) => JSON.stringify(a))
        .join(",")});`;
      const sandbox = {
        document,
        window: windowGlobals,
        location: { href: url },
      };
      const script = new vm.Script(source);
      const context = vm.createContext(sandbox);
      const value = script.runInContext(context);
      return typeof value === "function" ? value() : value;
    },
  };
}

module.exports = { makeFakePage };