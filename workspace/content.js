'use strict';

const v = require('./validation');
const { check } = require('./errors');

const BLOCKS = ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'horizontalRule', 'noteAttachment'];
const EMPTY_DOCUMENT = { type: 'doc', content: [{ type: 'paragraph' }] };

function documentContent(input, schemaVersion = 1) {
  check(schemaVersion === 1, 'UNSUPPORTED_CONTENT_SCHEMA', 'Unsupported note content schema');
  const content = v.json(input, 2 * 1024 * 1024);
  const lines = [];
  function visit(node, parent) {
    v.object(node, ['type', 'attrs', 'content', 'text', 'marks'], 'content node');
    const type = v.choice(node.type, ['doc', ...BLOCKS, 'text', 'hardBreak'], 'content node type');
    if (parent === null) check(type === 'doc', 'INVALID_INPUT', 'Content root must be a document');
    else {
      const allowed = parent === 'doc' || parent === 'blockquote' ? BLOCKS.filter((block) => block !== 'listItem')
        : ['bulletList', 'orderedList'].includes(parent) ? ['listItem']
          : parent === 'listItem' ? BLOCKS.filter((block) => block !== 'listItem')
            : ['paragraph', 'heading'].includes(parent) ? ['text', 'hardBreak']
              : parent === 'codeBlock' ? ['text'] : [];
      check(allowed.includes(type), 'INVALID_INPUT', 'Invalid document nesting');
    }
    if (node.attrs !== undefined) {
      const keys = type === 'noteAttachment' ? ['id'] : type === 'heading' ? ['level'] : type === 'orderedList' ? ['start', 'type'] : type === 'codeBlock' ? ['language'] : [];
      v.object(node.attrs, keys, 'node attributes');
      if (type === 'heading') v.integer(node.attrs.level, 'heading level', 1, 6);
      if (type === 'orderedList') {
        v.integer(node.attrs.start ?? 1, 'list start', 1, 1000000);
        if (node.attrs.type != null) v.choice(node.attrs.type, ['1', 'a', 'A', 'i', 'I'], 'list type');
      }
      if (type === 'codeBlock' && node.attrs.language != null) v.text(node.attrs.language, 'code language', 100);
    }
    if (type === 'heading') check(node.attrs && node.attrs.level, 'INVALID_INPUT', 'Heading level is required');
    if (type === 'noteAttachment') v.uuid(node.attrs?.id, 'attachment id');
    if (type === 'text') {
      v.text(node.text, 'node text', 1024 * 1024, true);
      check(node.text.length > 0, 'INVALID_INPUT', 'Text nodes cannot be empty');
      check(parent !== 'codeBlock' || node.marks === undefined, 'INVALID_INPUT', 'Code blocks cannot contain marked text');
      check(node.content === undefined && node.attrs === undefined, 'INVALID_INPUT', 'Text node has invalid fields');
    } else check(node.text === undefined && node.marks === undefined, 'INVALID_INPUT', 'Only text nodes can have text or marks');
    if (node.marks !== undefined) {
      check(Array.isArray(node.marks) && node.marks.length <= 8, 'INVALID_INPUT', 'Invalid marks');
      const seen = new Set();
      for (const mark of node.marks) {
        v.object(mark, ['type', 'attrs'], 'mark');
        v.choice(mark.type, ['bold', 'italic', 'strike', 'code', 'underline', 'link'], 'mark type');
        check(!seen.has(mark.type), 'INVALID_INPUT', 'Duplicate mark');
        seen.add(mark.type);
        if (mark.type === 'link') {
          v.object(mark.attrs, ['href', 'target', 'rel', 'class'], 'link attributes');
          const href = v.text(mark.attrs.href, 'link', 4096);
          let url;
          try { url = new URL(href); } catch { check(false, 'INVALID_INPUT', 'Link must be an absolute URL'); }
          check(['https:', 'http:', 'mailto:'].includes(url.protocol), 'INVALID_INPUT', 'Unsafe link protocol');
          for (const key of ['target', 'rel', 'class']) if (mark.attrs[key] != null) v.text(mark.attrs[key], `link ${key}`, 200, true);
        } else check(mark.attrs === undefined, 'INVALID_INPUT', 'Unsupported mark attributes');
      }
    }
    check(node.content === undefined || Array.isArray(node.content), 'INVALID_INPUT', 'Node content must be an array');
    if (['doc', 'blockquote', 'bulletList', 'orderedList', 'listItem'].includes(type)) {
      check(node.content?.length > 0, 'INVALID_INPUT', 'Container content cannot be empty');
    }
    if (type === 'listItem') check(node.content[0]?.type === 'paragraph', 'INVALID_INPUT', 'List item starts with a paragraph');
    if (['text', 'hardBreak', 'horizontalRule', 'noteAttachment'].includes(type)) check(node.content === undefined, 'INVALID_INPUT', 'Leaf nodes cannot have children');
    let text = type === 'text' ? node.text : type === 'hardBreak' ? '\n' : '';
    for (const child of node.content || []) text += visit(child, type);
    if (['paragraph', 'heading', 'codeBlock'].includes(type)) { lines.push(text); return ''; }
    return text;
  }
  visit(content, null);
  const plainText = lines.join('\n');
  return { content, contentSchemaVersion: 1, plainText, contentHash: v.hash(v.stableJson(content, 2 * 1024 * 1024)) };
}

function attachmentIds(content) {
  const ids = new Set();
  const visit = (node) => {
    if (node.type === 'noteAttachment') ids.add(node.attrs.id);
    for (const child of node.content ?? []) visit(child);
  };
  visit(content);
  return [...ids];
}

module.exports = { documentContent, EMPTY_DOCUMENT, attachmentIds };
