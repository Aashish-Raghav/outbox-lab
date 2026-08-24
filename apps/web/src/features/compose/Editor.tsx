'use client';

import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import { EditorContent, useEditor } from '@tiptap/react';
import { cn } from '@/lib/format';
import { Toolbar } from './Toolbar';

export interface EditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * The rich-text body field.
 *
 * Tiptap rather than a `contenteditable` div, because the design's toolbar
 * needs real active-state queries (`isActive('bold')`) and a working undo
 * stack, both of which `document.execCommand` no longer reliably provides.
 *
 * What comes out is HTML that goes straight into an email, so the server
 * sanitises it again on the way in — a client-side editor is a formatting tool,
 * not a security boundary.
 */
export function BodyEditor({ value, onChange, placeholder, className }: EditorProps) {
  const editor = useEditor({
    // Next renders this on the server first; letting Tiptap paint immediately
    // produces markup React then disagrees with during hydration.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        // Emails do not carry a stylesheet, so a code block would arrive as
        // unstyled preformatted text. Dropped rather than shipped broken.
        codeBlock: false,
        horizontalRule: {},
      }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        // Recipients' mail clients open links in their own context anyway; the
        // rel attributes matter for the preview rendered in this dashboard.
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      Placeholder.configure({ placeholder: placeholder ?? 'Type Your Reply...' }),
    ],
    content: value,
    onUpdate: ({ editor: instance }) => {
      // Tiptap represents "empty" as `<p></p>`; forwarding that would satisfy
      // the API's `min(1)` body check with a visually blank email.
      onChange(instance.isEmpty ? '' : instance.getHTML());
    },
    editorProps: {
      attributes: {
        class: 'rich-text min-h-[220px] px-4 py-3 focus:outline-none',
      },
    },
  });

  return (
    <div className={cn('overflow-hidden rounded-card border border-line', className)}>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}
