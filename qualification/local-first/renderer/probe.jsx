import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

const content = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Synthetic note' }] },
    { type: 'paragraph', content: [
      { type: 'text', marks: [{ type: 'bold' }], text: 'Client follow-up' },
      { type: 'text', text: ' saved locally.' },
    ] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Review the proposal' }] },
    ] }] },
    { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'const local = true;' }] },
  ],
};

function Probe() {
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } })],
    content,
    enableContentCheck: true,
    onContentError({ error }) { window.__qualification = { error: error.message }; },
  });

  useEffect(() => {
    if (!editor) return;
    try {
      const initial = editor.getJSON();
      if (JSON.stringify(initial) !== JSON.stringify(content)) {
        throw new Error('Versioned document changed during editor round-trip');
      }
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: 'paragraph', content: [{ type: 'text', text: 'Offline edit survived.' }],
      });
      const edited = editor.getJSON();
      editor.commands.setContent(edited);
      if (JSON.stringify(editor.getJSON()) !== JSON.stringify(edited)) {
        throw new Error('Edited document changed during reload');
      }
      window.__qualification = {
        mounted: true,
        roundTrip: true,
        text: editor.getText(),
        document: edited,
        nodeAccess: typeof window.require,
        processAccess: typeof window.process,
      };
    } catch (error) {
      window.__qualification = { error: error.message };
    }
  }, [editor]);

  return <main><h1>Synthetic qualification note</h1><EditorContent editor={editor} /></main>;
}

createRoot(document.getElementById('root')).render(<Probe />);
