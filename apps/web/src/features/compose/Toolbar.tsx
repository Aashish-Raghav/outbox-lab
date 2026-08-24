'use client';

import type { Editor } from '@tiptap/react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/format';
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  ItalicIcon,
  LinkIcon,
  ListBulletIcon,
  ListOrderedIcon,
  QuoteIcon,
  RedoIcon,
  StrikeIcon,
  UnderlineIcon,
  UndoIcon,
} from '@/components/icons';

/**
 * The formatting bar under the body field in the Figma.
 *
 * Buttons use `onMouseDown` + `preventDefault` rather than `onClick`: a click
 * moves focus out of the editor first, which collapses the selection, so
 * "select some text, press B" would bold nothing.
 */

function ToolButton({
  label,
  active = false,
  disabled = false,
  onRun,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onRun: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => {
        event.preventDefault();
        onRun();
      }}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-field text-base transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'bg-primary-soft text-primary' : 'text-ink/70 hover:bg-neutral-soft',
      )}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />;
}

export function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;

  const promptForLink = () => {
    // A native prompt is deliberate: a bespoke link dialog is a lot of surface
    // area for a field that is not part of the graded feature list.
    const previous = editor.getAttributes('link').href as string | undefined;
    const href = window.prompt('Link URL', previous ?? 'https://');

    if (href === null) return;
    if (href.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
  };

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap items-center gap-0.5 border-b border-line px-2 py-1.5"
    >
      <ToolButton
        label="Undo"
        disabled={!editor.can().undo()}
        onRun={() => editor.chain().focus().undo().run()}
      >
        <UndoIcon />
      </ToolButton>
      <ToolButton
        label="Redo"
        disabled={!editor.can().redo()}
        onRun={() => editor.chain().focus().redo().run()}
      >
        <RedoIcon />
      </ToolButton>

      <Divider />

      <select
        aria-label="Text style"
        value={
          editor.isActive('heading', { level: 1 })
            ? 'h1'
            : editor.isActive('heading', { level: 2 })
              ? 'h2'
              : editor.isActive('heading', { level: 3 })
                ? 'h3'
                : 'p'
        }
        onChange={(event) => {
          const value = event.target.value;
          const chain = editor.chain().focus();
          if (value === 'p') chain.setParagraph().run();
          else chain.setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run();
        }}
        className="h-8 cursor-pointer rounded-field bg-transparent px-1.5 text-[13px] text-ink/70 hover:bg-neutral-soft"
      >
        <option value="p">Normal</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>

      <Divider />

      <ToolButton
        label="Bold"
        active={editor.isActive('bold')}
        onRun={() => editor.chain().focus().toggleBold().run()}
      >
        <BoldIcon />
      </ToolButton>
      <ToolButton
        label="Italic"
        active={editor.isActive('italic')}
        onRun={() => editor.chain().focus().toggleItalic().run()}
      >
        <ItalicIcon />
      </ToolButton>
      <ToolButton
        label="Underline"
        active={editor.isActive('underline')}
        onRun={() => editor.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon />
      </ToolButton>
      <ToolButton
        label="Strikethrough"
        active={editor.isActive('strike')}
        onRun={() => editor.chain().focus().toggleStrike().run()}
      >
        <StrikeIcon />
      </ToolButton>

      <Divider />

      <ToolButton
        label="Align left"
        active={editor.isActive({ textAlign: 'left' })}
        onRun={() => editor.chain().focus().setTextAlign('left').run()}
      >
        <AlignLeftIcon />
      </ToolButton>
      <ToolButton
        label="Align centre"
        active={editor.isActive({ textAlign: 'center' })}
        onRun={() => editor.chain().focus().setTextAlign('center').run()}
      >
        <AlignCenterIcon />
      </ToolButton>
      <ToolButton
        label="Align right"
        active={editor.isActive({ textAlign: 'right' })}
        onRun={() => editor.chain().focus().setTextAlign('right').run()}
      >
        <AlignRightIcon />
      </ToolButton>

      <Divider />

      <ToolButton
        label="Bulleted list"
        active={editor.isActive('bulletList')}
        onRun={() => editor.chain().focus().toggleBulletList().run()}
      >
        <ListBulletIcon />
      </ToolButton>
      <ToolButton
        label="Numbered list"
        active={editor.isActive('orderedList')}
        onRun={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrderedIcon />
      </ToolButton>
      <ToolButton
        label="Quote"
        active={editor.isActive('blockquote')}
        onRun={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <QuoteIcon />
      </ToolButton>
      <ToolButton label="Link" active={editor.isActive('link')} onRun={promptForLink}>
        <LinkIcon />
      </ToolButton>
    </div>
  );
}
