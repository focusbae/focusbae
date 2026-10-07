'use strict';

class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

function check(condition, code, message) {
  if (!condition) throw new WorkspaceError(code, message);
}

module.exports = { WorkspaceError, check };
