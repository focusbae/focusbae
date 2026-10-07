"use strict";
const { policy } = require("./local-runtime");
module.exports = {
  policy: () => policy,
  assert: (purpose) => policy.assert(purpose),
  allows: (purpose) => policy.allows(purpose),
  ticket: () => policy.ticket(),
};
