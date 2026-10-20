window.__ModuleLoader__.load({
  id: 'dsh-markdown-live',
  factory(require) {
    'use strict'

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const MarkdownText = primitives.MarkdownText

    /** Locale namespace of this package. */
    const NS = 'markdown-live'
    /** The Lexical powered composer contenteditable (host contract). */
    const COMPOSER_INPUT = '[data-composer-input]'
    /** Lexical text-format bits (bold | italic | strikethrough | code). */
    const FMT_BOLD = 1
    const FMT_ITALIC = 2
    const FMT_STRIKE = 4
    const FMT_CODE = 16
    const FMT_ALL = FMT_BOLD | FMT_ITALIC | FMT_STRIKE | FMT_CODE
    /** Lexical text-node detail bit that stops normalization from merging. */
    const DETAIL_UNMERGEABLE = 2
    /** History tag that folds our structural writes into the user's edit. */
    const HISTORY_MERGE_TAG = 'history-merge'
    /** Cap self-triggered structural writes per rolling second. */
    const MAX_WRITES_PER_SECOND = 24
    /** Above this draft size the renderer steps aside to keep typing snappy. */
    const MAX_RENDER_CHARS = 12000
    /** Shared empty inline analysis (never mutated). */
    const EMPTY_INLINE = { spans: [], marks: [] }

    // =========================================================================
    // Flat-line Markdown tokenizer (shared by the composer renderer; the user
    // message renderer delegates to the host's own Markdown primitives).
    // =========================================================================

    /** Word-ish character test used by CommonMark-style emphasis flanking. */
    function isWordCode(code) {
      return (
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 0x00c0 && code <= 0x024f) ||
        (code >= 0x0400 && code <= 0x04ff) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0x3400 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xff10 && code <= 0xff19) ||
        (code >= 0xff21 && code <= 0xff3a) ||
        (code >= 0xff41 && code <= 0xff5a)
      )
    }

    /** Whitespace test (space, tab and friends; line feeds never reach here). */
    function isSpaceCode(code) {
      return code === 32 || code === 9 || code === 0x3000
    }

    /**
     * Find the start of the next run of exactly `len` occurrences of `ch`.
     * Returns -1 when the run does not exist.
     */
    function findRun(text, from, ch, len) {
      let i = from
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === ch) {
          let run = 1
          while (text[i + run] === ch) run += 1
          if (run === len) return i
          i += run
          continue
        }
        i += 1
      }
      return -1
    }

    /** A closing emphasis run: not part of a longer run, preceded by content. */
    function findEmphasisClose(text, from, ch, len) {
      let i = from
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] !== ch) {
          i += 1
          continue
        }
        let run = 1
        while (text[i + run] === ch) run += 1
        const before = text[i - 1]
        const after = text[i + run]
        const closes =
          run >= len &&
          before !== undefined &&
          !isSpaceCode(before.charCodeAt(0)) &&
          (ch !== '_' || after === undefined || !isWordCode(after.charCodeAt(0)))
        if (closes && i > from) return i
        i += run
      }
      return -1
    }

    /** Parse `[label](destination)` starting at `[`. Null when malformed. */
    function parseLinkAt(text, open) {
      let depth = 0
      let close = -1
      for (let i = open + 1; i < text.length; i += 1) {
        const ch = text[i]
        if (ch === '\\') {
          i += 1
          continue
        }
        if (ch === '[') return null
        if (ch === ']' && depth === 0) {
          close = i
          break
        }
      }
      if (close < 0 || text[close + 1] !== '(') return null
      let paren = 1
      let end = -1
      for (let i = close + 2; i < text.length; i += 1) {
        const ch = text[i]
        if (ch === '\\') {
          i += 1
          continue
        }
        if (ch === '(') paren += 1
        else if (ch === ')') {
          paren -= 1
          if (paren === 0) {
            end = i
            break
          }
        }
      }
      if (end < 0) return null
      if (close === open + 1) return null
      return { labelStart: open + 1, labelEnd: close, urlStart: close + 2, urlEnd: end, end }
    }

    /**
     * Tokenize one visual line into styled spans plus marker ranges.
     * Spans: { start, end, flags, link? }. Marks: { start, end, kind }.
     */
    function parseInline(text) {
      const spans = []
      const marks = []
      const n = text.length
      let i = 0
      while (i < n) {
        const ch = text[i]
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === '`') {
          let run = 1
          while (text[i + run] === '`') run += 1
          // A backtick followed by whitespace is prose, not an inline-code
          // opener (and ```` ``` ```` fence lines are handled block-wise).
          if (isSpaceCode(text.charCodeAt(i + run))) {
            i += run
            continue
          }
          const close = findRun(text, i + run, '`', run)
          if (close > i + run) {
            spans.push({ start: i + run, end: close, flags: FMT_CODE })
            marks.push({ start: i, end: i + run, kind: 'code' })
            marks.push({ start: close, end: close + run, kind: 'code' })
            i = close + run
            continue
          }
          i += run
          continue
        }
        if (ch === '!' && text[i + 1] === '[') {
          const link = parseLinkAt(text, i + 1)
          if (link !== null) {
            marks.push({ start: i, end: i + 1, kind: 'link' })
            marks.push({ start: link.labelEnd, end: link.end + 1, kind: 'link' })
            spans.push({ start: link.labelStart, end: link.labelEnd, flags: 0, link: true })
            i = link.end + 1
            continue
          }
          i += 1
          continue
        }
        if (ch === '[') {
          const link = parseLinkAt(text, i)
          if (link !== null) {
            marks.push({ start: i, end: i + 1, kind: 'link' })
            marks.push({ start: link.labelEnd, end: link.end + 1, kind: 'link' })
            spans.push({ start: link.labelStart, end: link.labelEnd, flags: 0, link: true })
            i = link.end + 1
            continue
          }
          i += 1
          continue
        }
        if (ch === '~' && text[i + 1] === '~') {
          const close = findEmphasisClose(text, i + 2, '~', 2)
          if (close > i + 2) {
            spans.push({ start: i + 2, end: close, flags: FMT_STRIKE })
            marks.push({ start: i, end: i + 2, kind: 'strike' })
            marks.push({ start: close, end: close + 2, kind: 'strike' })
            i = close + 2
            continue
          }
          i += 2
          continue
        }
        if (ch === '*' || ch === '_') {
          let run = 1
          while (text[i + run] === ch && run < 3) run += 1
          const before = i > 0 ? text.charCodeAt(i - 1) : -1
          const after = i + run < n ? text.charCodeAt(i + run) : -1
          // A `_` opener must sit on a word boundary; `*` may open mid-word.
          if (ch === '_' && before >= 0 && isWordCode(before)) {
            i += run
            continue
          }
          if (after < 0 || isSpaceCode(after)) {
            i += run
            continue
          }
          if (ch === '_' && after >= 0 && isWordCode(after) && before >= 0 && isWordCode(before)) {
            i += run
            continue
          }
          let matched = false
          const lengths = run >= 3 ? [3, 2, 1] : run === 2 ? [2, 1] : [1]
          for (const len of lengths) {
            const close = findEmphasisClose(text, i + len, ch, len)
            if (close < 0 || close === i + len) continue
            let flags = 0
            if (len >= 2) flags |= FMT_BOLD
            if (len === 1 || len === 3) flags |= FMT_ITALIC
            spans.push({ start: i + len, end: close, flags })
            marks.push({ start: i, end: i + len, kind: 'emphasis' })
            marks.push({ start: close, end: close + len, kind: 'emphasis' })
            i = close + len
            matched = true
            break
          }
          if (!matched) i += run
          continue
        }
        i += 1
      }
      return { spans, marks }
    }

    // =========================================================================
    // Block classification: one entry per visual line (a paragraph after the
    // normalization stage). Roles drive the block CSS; marks drive hidden
    // syntax glyphs.
    // =========================================================================

    const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*$/
    const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
    const HEADING_RE = /^( {0,3})(#{1,6})([ \t]+)(?=\S)/
    const QUOTE_RE = /^( {0,3})(>[ \t])/
    const BULLET_RE = /^( *)([-*+])([ \t]+)(?=\S)/
    const ORDERED_RE = /^( *)(\d{1,9})([.)])([ \t]+)(?=\S)/
    const TASK_RE = /^\[([ xX])\]([ \t]+|$)/

    /** All chars of a line as one marker range. */
    function wholeLineMark(text, kind) {
      return text.length === 0 ? [] : [{ start: 0, end: text.length, kind }]
    }

    /**
     * Marker ranges stop BEFORE the whitespace that separates the marker from
     * the content. Keeping that separator a plain text leaf gives typing/IME a
     * normal text node to compose in, so the caret never has to sit inside a
     * dimmed marker glyph.
     */
    function markEndWithoutTrailingSpace(text, start, end) {
      let tail = end
      while (tail > start && (text[tail - 1] === ' ' || text[tail - 1] === '\t')) tail -= 1
      return tail
    }

    /**
     * Hide every trailing separator space except the last one, so an input like
     * `-   item` or `>   quoted` renders with the same single-space gap that the
     * Markdown renderer gives it (extra spaces used to widen the composer gap).
     */
    function markEndKeepingOneSpace(text, start, end) {
      if (end <= start) return end
      const last = text[end - 1]
      if (last !== ' ' && last !== '\t') return end
      return end - 1
    }

    /** Nesting level from the leading-space run of a list line. */
    function indentLevelOf(spaces) {
      if (spaces <= 0) return 0
      return Math.min(5, Math.max(1, Math.ceil(spaces / 2)))
    }

    /** Marker kinds whose caret is homed out of the glyph (block prefixes). */
    const BLOCK_MARK_KINDS = new Set(['bullet', 'ordered', 'heading', 'quote', 'task-open', 'task-done'])

    /** The list context of one line, or null when the line is not a list item. */
    function listContextOf(text) {
      const bullet = BULLET_RE.exec(text)
      if (bullet !== null) {
        const rest = text.slice(bullet[0].length)
        const task = TASK_RE.exec(rest)
        if (task !== null) {
          return { kind: 'task', indent: bullet[1].length, contentStart: bullet[0].length + task[0].length }
        }
        return {
          kind: 'bullet',
          indent: bullet[1].length,
          bulletChar: bullet[2],
          contentStart: bullet[0].length,
        }
      }
      const ordered = ORDERED_RE.exec(text)
      if (ordered !== null) {
        return {
          kind: 'ordered',
          indent: ordered[1].length,
          number: Number.parseInt(ordered[2], 10) || 1,
          delimiter: ordered[3],
          contentStart: ordered[0].length,
        }
      }
      return null
    }

    /** A list marker with no item content (`- `, `1. `, `- [ ] `). */
    const EMPTY_LIST_RE = /^([ \t]*)(?:[-*+](?:[ \t]+\[[ xX]\])?|\d{1,9}[.)])[ \t]+$/
    /** A quote marker with no quoted content (`> `). */
    const EMPTY_QUOTE_RE = /^ {0,3}>[ \t]+$/

    /** The blockquote context of one line, or null. */
    function quoteContextOf(text) {
      const quote = QUOTE_RE.exec(text)
      if (quote === null) return null
      return { indent: quote[1].length, contentStart: quote[0].length }
    }

    /** Remove the first `count` characters of a block (used for marker exit). */
    function removePrefixInside(blockNode, count) {
      let remaining = count
      for (const leaf of readLeaves(blockNode)) {
        if (remaining <= 0) break
        if (leaf.kind !== 'text') {
          remaining -= leaf.text.length
          continue
        }
        const text = leaf.node.getTextContent()
        if (text.length <= remaining) {
          remaining -= text.length
          leaf.node.remove()
          continue
        }
        leaf.node.setTextContent(text.slice(remaining))
        remaining = 0
      }
      if (typeof blockNode.selectStart === 'function') blockNode.selectStart()
    }

    /** Insert the body + closing fence of an auto-completed code block. */
    function completeFenceInside(editor, blockNode) {
      const Paragraph = editor._nodes?.get?.('paragraph')?.klass
      const Text = editor._nodes?.get?.('text')?.klass
      if (Paragraph == null || Text == null) return
      const body = new Paragraph()
      const close = new Paragraph()
      close.append(new Text('```'))
      blockNode.insertAfter(body)
      body.insertAfter(close)
      if (typeof body.selectStart === 'function') body.selectStart()
    }

    /**
     * Continue a block prefix (list marker / quote marker) on the next line.
     * The new paragraph is created immediately, the marker is split away from
     * its trailing separator, and the caret lives IN the separator text node.
     * Typing or IME composition therefore happens in a plain text node instead
     * of inside a dimmed marker glyph.
     */
    function insertContinuationInside(editor, blockNode, marker) {
      const selection = liveSelection(editor)
      if (selection == null || typeof selection.insertText !== 'function') return
      selection.insertText('\n' + marker)
      promoteSoftLines(editor, blockNode)
      const next = typeof blockNode.getNextSibling === 'function' ? blockNode.getNextSibling() : null
      if (next == null) return
      const type = next.__type ?? (typeof next.getType === 'function' ? next.getType() : null)
      if (type !== 'paragraph' || typeof next.getFirstChild !== 'function') return
      const tail = marker.length > 1 ? marker[marker.length - 1] : ''
      const separated = tail === ' ' || tail === '\t' ? marker.length - 1 : marker.length
      const first = next.getFirstChild()
      if (first != null && typeof first.splitText === 'function') {
        const size = typeof first.getTextContentSize === 'function'
          ? first.getTextContentSize()
          : first.getTextContent().length
        if (size > separated) {
          try {
            const parts = first.splitText(separated)
            const head = parts[0]
            if (head != null && typeof head.toggleUnmergeable === 'function' && head.isUnmergeable?.() !== true) {
              head.toggleUnmergeable()
            }
            const remainder = parts[1]
            if (remainder != null && typeof remainder.select === 'function') {
              const at = Math.min(1, remainder.getTextContent().length)
              remainder.select(at, at)
              return
            }
          } catch {
            // Fall back to the element boundary below.
          }
        }
      }
      if (typeof next.select === 'function') next.select(1, 1)
    }

    /** The caret's flat character offset inside one block, or null. */
    function caretFlatOffset(block, anchor) {
      if (anchor == null) return null
      for (const leaf of block.leaves) {
        if (leaf.node.getKey() !== anchor.key) continue
        if (leaf.kind === 'text') return leaf.start + Math.min(anchor.offset ?? 0, leaf.text.length)
        return leaf.start + ((anchor.offset ?? 0) > 0 ? 1 : 0)
      }
      if (anchor.key === block.node.getKey()) {
        let index = anchor.offset ?? 0
        let at = 0
        for (const leaf of block.leaves) {
          if (index <= 0) break
          at = leaf.start + leaf.text.length
          index -= 1
        }
        return at
      }
      return null
    }

    /**
     * Classify every line of a draft. Fence state carries across lines; `p`
     * is the inert fallback. Each result also carries the block-level marker
     * ranges and, for fenced/rule lines, suppresses inline parsing.
     */
    function classifyLines(texts) {
      const out = []
      let fence = null
      for (const text of texts) {
        if (fence !== null) {
          const close = FENCE_RE.exec(text)
          if (close !== null && close[1][0] === fence.ch) {
            out.push({ role: 'fence-close', lang: null, marks: wholeLineMark(text, 'fence'), noInline: true })
            fence = null
          } else {
            out.push({ role: 'fence-body', lang: null, marks: [], noInline: true })
          }
          continue
        }
        const open = FENCE_RE.exec(text)
        if (open !== null) {
          fence = { ch: open[1][0] }
          out.push({ role: 'fence-open', lang: open[2] || null, marks: wholeLineMark(text, 'fence'), noInline: true })
          continue
        }
        if (HR_RE.test(text)) {
          out.push({ role: 'hr', lang: null, marks: wholeLineMark(text, 'hr'), noInline: true })
          continue
        }
        const heading = HEADING_RE.exec(text)
        if (heading !== null) {
          const rawEnd = heading[1].length + heading[2].length + heading[3].length
          const end = markEndWithoutTrailingSpace(text, 0, rawEnd)
          out.push({
            role: 'h' + heading[2].length,
            lang: null,
            level: 0,
            marks: end > 0 ? [{ start: 0, end, kind: 'heading' }] : [],
            noInline: false,
          })
          continue
        }
        const quote = QUOTE_RE.exec(text)
        if (quote !== null) {
          out.push({
            role: 'quote',
            lang: null,
            level: 0,
            marks: [{ start: 0, end: markEndKeepingOneSpace(text, 0, quote[0].length), kind: 'quote' }],
            noInline: false,
          })
          continue
        }
        const bullet = BULLET_RE.exec(text)
        if (bullet !== null) {
          const level = indentLevelOf(bullet[1].length)
          const marks = [{ start: 0, end: markEndKeepingOneSpace(text, 0, bullet[0].length), kind: 'bullet' }]
          const rest = text.slice(bullet[0].length)
          const task = TASK_RE.exec(rest)
          if (task !== null) {
            const taskStart = bullet[0].length
            marks.push({
              start: taskStart,
              end: markEndKeepingOneSpace(text, taskStart, taskStart + task[0].length),
              kind: task[1] === ' ' ? 'task-open' : 'task-done',
            })
            out.push({ role: 'task', lang: null, level, marks, noInline: false })
            continue
          }
          out.push({ role: 'bullet', lang: null, level, marks, noInline: false })
          continue
        }
        const ordered = ORDERED_RE.exec(text)
        if (ordered !== null) {
          out.push({
            role: 'ordered',
            lang: null,
            level: indentLevelOf(ordered[1].length),
            marks: [
              { start: 0, end: markEndKeepingOneSpace(text, 0, ordered[0].length), kind: 'ordered' },
            ],
            noInline: false,
          })
          continue
        }
        out.push({ role: null, lang: null, level: 0, marks: [], noInline: false })
      }
      return out
    }

    // =========================================================================
    // Lexical draft model. One block is one root child; leaves flatten text,
    // line breaks, nested inline elements and atomic reference chips.
    // =========================================================================

    function flattenNode(node, leaves, offset) {
      let at = offset
      for (const kid of node.getChildren()) {
        const type = kid.__type
        if (typeof kid.__text === 'string') {
          leaves.push({ kind: 'text', node: kid, text: kid.getTextContent(), start: at })
          at += kid.getTextContent().length
        } else if (type === 'reference-chip') {
          const value = typeof kid.getTextContent === 'function' ? kid.getTextContent() : ''
          leaves.push({ kind: 'chip', node: kid, text: value, start: at })
          at += value.length
        } else if (type === 'linebreak') {
          leaves.push({ kind: 'br', node: kid, text: '\n', start: at })
          at += 1
        } else if (typeof kid.getChildren === 'function') {
          at = flattenNode(kid, leaves, at)
        }
      }
      return at
    }

    /** Read every root child of the live editor as a flat line model. */
    function readBlocks(editor) {
      const map = editor.getEditorState()._nodeMap
      const root = map?.get?.('root')
      if (root == null || typeof root.getChildren !== 'function') return []
      return root.getChildren().map((node) => {
        const leaves = []
        if (typeof node.getChildren === 'function') flattenNode(node, leaves, 0)
        return { node, leaves, text: leaves.map((leaf) => leaf.text).join('') }
      })
    }

    /** Re-read one block's leaves (used right after a split inside update). */
    function readLeaves(blockNode) {
      const leaves = []
      flattenNode(blockNode, leaves, 0)
      return leaves
    }

    /** The live (pending-aware) selection of the editor. */
    function liveSelection(editor) {
      const pending = editor._pendingEditorState
      if (pending != null && pending._selection !== undefined) return pending._selection
      return editor.getEditorState()._selection
    }

    /** The root-child key holding the caret, or null. */
    function caretBlockKey(editor) {
      const sel = liveSelection(editor)
      const anchor = sel?.anchor
      if (anchor?.key === undefined) return null
      const map = editor.getEditorState()._nodeMap
      let node = map?.get?.(anchor.key)
      let guard = 0
      while (node != null && guard < 64) {
        guard += 1
        const parent = typeof node.getParent === 'function' ? node.getParent() : null
        if (parent != null && parent.getKey?.() === 'root') return node.getKey()
        node = parent
      }
      return null
    }

    /** The IME composition key while composition owns the caret. */
    function compositionKey(editor) {
      return editor._compositionKey
    }

    /**
     * Move one selection endpoint off a node that is about to be removed.
     */
    function rehomePoint(point, separatorKey, beforeNode, para, offset) {
      if (point == null || point.key !== separatorKey) return
      if (offset > 0) {
        point.set(para.getKey(), 0, 'element')
        return
      }
      if (beforeNode != null && typeof beforeNode.getTextContent === 'function') {
        point.set(beforeNode.getKey(), beforeNode.getTextContent().length, 'text')
        return
      }
      point.set(para.getKey(), 0, 'element')
    }

    /**
     * Promote soft line breaks into paragraphs, so every visual line becomes a
     * block the renderer can classify. Both shapes occur in this composer:
     * Shift+Enter inserts a line-break node, while pasted/inserted text keeps
     * literal "\n" characters inside one text node. The submitted text is
     * unchanged either way: the composer projection joins block children with
     * exactly ONE newline (see $composerLayout), so moving a "\n" out of a text
     * leaf and into a paragraph gap keeps the clipboard text byte-identical.
     */
    function promoteSoftLines(editor, blockNode) {
      const klass = editor._nodes?.get?.('paragraph')?.klass
      if (klass == null) return false
      let current = blockNode
      let changed = false
      for (let guard = 0; guard < 1000; guard += 1) {
        let breakNode = null
        let newlineLeaf = null
        let newlineAt = -1
        for (const leaf of readLeaves(current)) {
          if (leaf.kind === 'br') {
            breakNode = leaf.node
            break
          }
          if (leaf.kind === 'text') {
            const pos = leaf.text.indexOf('\n')
            if (pos >= 0) {
              newlineLeaf = leaf.node
              newlineAt = pos
              break
            }
          }
        }
        if (breakNode === null && newlineLeaf === null) return changed
        let separator = null
        let beforeNode = null
        if (breakNode !== null) {
          separator = breakNode
        } else {
          // TextNode.splitText ignores offset 0, so a leading newline is split
          // at 1 instead: [ "\n" ][ rest ] and the newline part is dropped.
          try {
            if (newlineAt === 0) {
              const parts = newlineLeaf.length === 1 ? [newlineLeaf] : newlineLeaf.splitText(1)
              separator = parts[0] ?? null
            } else {
              const parts = newlineLeaf.splitText(newlineAt, newlineAt + 1)
              beforeNode = parts[0] ?? null
              separator = parts[1] ?? null
            }
          } catch {
            return changed
          }
          if (separator === null) return changed
        }
        const para = new klass()
        const separatorIndex =
          typeof separator.getIndexWithinParent === 'function' ? separator.getIndexWithinParent() : -1
        current.insertAfter(para)
        let mover = separator.getNextSibling()
        while (mover !== null) {
          const next = mover.getNextSibling()
          para.append(mover)
          mover = next
        }
        // A caret parked exactly on the soft break (or an element point past it)
        // would be left on a removed node / clamped to the end of the previous
        // line; move it to the adjacent character (line end or new line start).
        const live = liveSelection(editor)
        const pointOffset = (point) =>
          point != null && point.key === separator.getKey() ? (point.offset ?? 0) : -1
        const aOffset = pointOffset(live?.anchor)
        const fOffset = pointOffset(live?.focus)
        if (aOffset >= 0) rehomePoint(live.anchor, separator.getKey(), beforeNode, para, aOffset)
        if (fOffset >= 0) rehomePoint(live.focus, separator.getKey(), beforeNode, para, fOffset)
        if (separatorIndex >= 0 && live != null) {
          for (const point of [live.anchor, live.focus]) {
            if (point == null || point.type !== 'element' || point.key !== current.getKey()) continue
            if ((point.offset ?? 0) > separatorIndex) point.set(para.getKey(), 0, 'element')
          }
        }
        separator.remove()
        current = para
        changed = true
      }
      return changed
    }

    // =========================================================================
    // Shape planning: split leaves at syntax boundaries, mark marker glyphs
    // unmergeable, and set the host's own text formats for the styled spans.
    // =========================================================================

    /** Desired format bits for a leaf fully covering [start, end). */
    function desiredFormat(spans, start, end) {
      let flags = 0
      for (const span of spans) {
        if (span.flags !== 0 && span.start <= start && end <= span.end) flags |= span.flags
      }
      return flags
    }

    /** Whether a leaf is exactly one marker range. */
    function markAt(marks, start, end) {
      for (const mark of marks) {
        if (mark.start === start && mark.end === end) return mark
      }
      return null
    }

    /** Whether any boundary falls strictly inside [start, end). */
    function hasBoundaryInside(boundaries, start, end) {
      let lo = 0
      let hi = boundaries.length - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const value = boundaries[mid]
        if (value <= start) lo = mid + 1
        else if (value >= end) hi = mid - 1
        else return true
      }
      return false
    }

    /**
     * Plan one block: null when the committed shape already matches, else the
     * sorted boundary list to split on (splits and formats apply together).
     */
    function planShape(block, analysis) {
      const len = block.text.length
      const boundarySet = new Set()
      for (const span of analysis.spans) {
        if (span.start > 0 && span.start < len) boundarySet.add(span.start)
        if (span.end > 0 && span.end < len) boundarySet.add(span.end)
      }
      for (const mark of analysis.marks) {
        if (mark.start > 0 && mark.start < len) boundarySet.add(mark.start)
        if (mark.end > 0 && mark.end < len) boundarySet.add(mark.end)
      }
      const boundaries = [...boundarySet].sort((a, b) => a - b)
      let offset = 0
      let needsWrite = false
      for (const leaf of block.leaves) {
        const start = offset
        const end = offset + leaf.text.length
        offset = end
        if (leaf.kind !== 'text' || leaf.text.length === 0) continue
        if (hasBoundaryInside(boundaries, start, end)) {
          needsWrite = true
          break
        }
        const mark = analysis.markByStart.get(start)
        if (mark !== undefined) {
          if (mark.end !== end) {
            needsWrite = true
            break
          }
          if ((leaf.node.getDetail() & DETAIL_UNMERGEABLE) === 0) {
            needsWrite = true
            break
          }
        }
        if ((leaf.node.getFormat() & FMT_ALL) !== desiredFormat(analysis.spans, start, end)) {
          needsWrite = true
          break
        }
      }
      if (!needsWrite) return null
      return { block, analysis, boundaries }
    }

    /** Apply one shape plan inside the editor update. */
    function applyShape(plan) {
      const { block, analysis, boundaries } = plan
      const splits = new Map()
      let offset = 0
      for (const leaf of block.leaves) {
        const start = offset
        const end = offset + leaf.text.length
        offset = end
        if (leaf.kind !== 'text' || leaf.text.length === 0) continue
        const local = []
        for (const boundary of boundaries) {
          if (boundary > start && boundary < end) local.push(boundary - start)
        }
        if (local.length > 0) splits.set(leaf.node, [...new Set(local)].sort((a, b) => a - b))
      }
      for (const [node, local] of splits) {
        try {
          node.splitText(...local)
        } catch {
          // A stale node simply stays unstyled this round.
        }
      }
      let at = 0
      for (const leaf of readLeaves(block.node)) {
        const start = at
        const end = at + leaf.text.length
        at = end
        if (leaf.kind !== 'text' || leaf.text.length === 0) continue
        const mark = markAt(analysis.marks, start, end)
        const wanted = mark === null ? desiredFormat(analysis.spans, start, end) : 0
        const current = leaf.node.getFormat()
        if ((current & FMT_ALL) !== wanted) {
          leaf.node.setFormat((current & ~FMT_ALL) | wanted)
        }
        if (mark !== null) {
          const detail = leaf.node.getDetail()
          if ((detail & DETAIL_UNMERGEABLE) === 0) leaf.node.setDetail(detail | DETAIL_UNMERGEABLE)
        }
      }
    }

    // =========================================================================
    // DOM presentation: class toggles only (never editor state). Language
    // attributes and class marks are re-derived every pass and idempotent.
    // =========================================================================

    /** Remove every class we may have left on an element. */
    function stripClasses(el) {
      let doomed = null
      for (const name of el.classList) {
        if (name.startsWith('dml-')) {
          if (doomed === null) doomed = []
          doomed.push(name)
        }
      }
      if (doomed !== null) el.classList.remove(...doomed)
      if (el.hasAttribute('data-dml-lang')) el.removeAttribute('data-dml-lang')
      if (el.hasAttribute('data-dml-spellcheck')) {
        el.removeAttribute('data-dml-spellcheck')
        el.removeAttribute('spellcheck')
      }
    }

    /** Strip our marks from one block subtree (block element + descendants). */
    function stripBlock(blockEl) {
      stripClasses(blockEl)
      for (const el of blockEl.querySelectorAll('[class*="dml-"]')) {
        if (el instanceof HTMLElement) stripClasses(el)
      }
    }

    /** Strip every mark our plugin ever painted under one composer root. */
    function sweepAll(root) {
      for (const el of root.querySelectorAll('[class*="dml-"]')) {
        if (el instanceof HTMLElement) stripClasses(el)
      }
    }

    /**
     * Paint one block's presentation (classes and the fence language
     * attribute) from its analysis. Scoped to the block so a keystroke only
     * repaints the block it touched. Markers stay dimmed on the caret's own
     * line and hide on every other line, giving the rendered look while
     * keeping the raw syntax editable where the caret is.
     */
    function paintBlock(editor, block, analysis, onCaretLine) {
      const blockEl = editor.getElementByKey(block.node.getKey())
      if (!(blockEl instanceof HTMLElement)) return false
      stripBlock(blockEl)
      blockEl.classList.add('dml-line')
      if (analysis.role !== null) blockEl.classList.add('dml-' + analysis.role)
      if (analysis.level > 0) blockEl.classList.add('dml-lvl-' + analysis.level)
      // Fence lines are code (including the language id): never spell them.
      const isFence = analysis.role !== null && analysis.role.indexOf('fence') === 0
      if (isFence) {
        blockEl.setAttribute('spellcheck', 'false')
        blockEl.setAttribute('data-dml-spellcheck', '')
      }
      if (analysis.lang !== null && analysis.lang !== '') {
        blockEl.setAttribute('data-dml-lang', analysis.lang)
      }
      if (onCaretLine) blockEl.classList.add('dml-caret')
      let at = 0
      for (const leaf of block.leaves) {
        const start = at
        const end = at + leaf.text.length
        at = end
        if (leaf.kind !== 'text' || leaf.text.length === 0) continue
        const el = editor.getElementByKey(leaf.node.getKey())
        if (!(el instanceof HTMLElement)) continue
        if (isFence) {
          el.setAttribute('spellcheck', 'false')
          el.setAttribute('data-dml-spellcheck', '')
        }
        const mark = analysis.markByStart.get(start)
        if (mark !== undefined && mark.end === end) {
          el.classList.add('dml-mark', 'dml-mark-' + mark.kind)
          el.classList.add(onCaretLine ? 'dml-mark-on' : 'dml-mark-off')
        } else {
          for (const span of analysis.spans) {
            if (span.link === true && span.start <= start && end <= span.end) {
              el.classList.add('dml-link')
              break
            }
          }
        }
      }
      return true
    }

    // =========================================================================
    // The restyle engine: editor update listener -> microtask pass -> at most
    // one structural update; DOM marks ride after the committed state.
    // =========================================================================

    function createLiveRenderer(log) {
      const wired = new WeakSet()
      const unwires = new Set()
      let scanPending = false
      let disposed = false
      let recentWrites = []
      let warned = false
      let sizeWarned = false
      let sizeSkipped = false
      /** Per-block analysis cache, invalidated by text or line-role changes. */
      const cache = new Map()
      /** Blocks whose committed DOM is stale after one of our own writes. */
      let recheck = new Set()
      let lastCaretKey = null
      let lastRoot = null
      let allDirty = true

      function warn(error) {
        if (warned) return
        warned = true
        log.warn('composer live rendering degraded', error)
      }

      function resolveEditor() {
        const el = document.querySelector(COMPOSER_INPUT)
        if (!(el instanceof HTMLElement)) return null
        const editor = el.__lexicalEditor
        return editor != null && typeof editor.getEditorState === 'function' ? editor : null
      }

      /**
       * One pass: read the committed draft, reuse cached analyses for unchanged
       * lines, paint only the lines whose presentation or caret state changed,
       * and commit at most one structural update. This keeps a keystroke's cost
       * proportional to the line being edited instead of the whole draft.
       */
      function restyle(editor) {
        if (disposed) return
        const composing = compositionKey(editor)
        if (composing !== null && composing !== undefined) return
        const root = document.querySelector(COMPOSER_INPUT)
        if (!(root instanceof HTMLElement)) return
        if (root !== lastRoot) {
          if (lastRoot instanceof HTMLElement) sweepAll(lastRoot)
          sweepAll(root)
          // The composer is prose mixed with code and Chinese: browser spell
          // checking only produces noisy red squiggles here.
          root.setAttribute('spellcheck', 'false')
          root.setAttribute('data-dml-spellcheck-root', '')
          cache.clear()
          recheck = new Set()
          lastCaretKey = null
          allDirty = true
          lastRoot = root
        }
        let structural = null
        let dom = null
        let skip = false
        try {
          editor.getEditorState().read(() => {
            const blocks = readBlocks(editor)
            if (blocks.length === 0) {
              cache.clear()
              return
            }
            let total = 0
            for (const block of blocks) total += block.text.length
            if (total > MAX_RENDER_CHARS) {
              if (!sizeWarned) {
                sizeWarned = true
                log.warn('draft is longer than ' + MAX_RENDER_CHARS + ' characters; live rendering is paused for it')
              }
              skip = true
              return
            }
            const needsSplit = (block) =>
              block.leaves.some(
                (leaf) => leaf.kind === 'br' || (leaf.kind === 'text' && leaf.text.indexOf('\n') >= 0),
              )
            if (blocks.some(needsSplit)) {
              structural = { kind: 'normalize', targets: blocks.filter(needsSplit) }
              return
            }
            const texts = blocks.map((block) => block.text)
            const roles = classifyLines(texts)
            const caretKey = caretBlockKey(editor)
            const analyses = new Array(blocks.length)
            const toPaint = new Set()
            const toPlan = []
            const live = new Set()
            for (let i = 0; i < blocks.length; i += 1) {
              const block = blocks[i]
              const key = block.node.getKey()
              live.add(key)
              const info = roles[i]
              const text = texts[i]
              let entry = cache.get(key)
              const textChanged = entry === undefined || entry.text !== text
              const roleChanged =
                entry !== undefined &&
                (entry.role !== info.role ||
                  entry.level !== (info.level ?? 0) ||
                  entry.noInline !== info.noInline ||
                  entry.lang !== info.lang)
              if (textChanged || roleChanged) {
                const inline = info.noInline ? EMPTY_INLINE : parseInline(text)
                const marks = info.marks.concat(inline.marks)
                const markByStart = new Map()
                for (const mark of marks) markByStart.set(mark.start, mark)
                entry = {
                  text,
                  role: info.role,
                  level: info.level ?? 0,
                  lang: info.lang,
                  noInline: info.noInline,
                  spans: inline.spans,
                  marks,
                  markByStart,
                }
                cache.set(key, entry)
                toPaint.add(key)
                toPlan.push(i)
              } else if (allDirty || recheck.has(key)) {
                toPaint.add(key)
                toPlan.push(i)
              }
              analyses[i] = entry
            }
            if (caretKey !== lastCaretKey) {
              if (lastCaretKey !== null && live.has(lastCaretKey)) toPaint.add(lastCaretKey)
              if (caretKey !== null) toPaint.add(caretKey)
            }
            if (allDirty) for (const key of live) toPaint.add(key)
            if (cache.size > live.size + 8) {
              for (const key of cache.keys()) if (!live.has(key)) cache.delete(key)
            }
            const plans = []
            for (const index of toPlan) {
              const plan = planShape(blocks[index], analyses[index])
              if (plan !== null) plans.push(plan)
            }
            if (plans.length > 0) structural = { kind: 'shape', plans }
            dom = { blocks, analyses, caretKey, toPaint }

          })
        } catch (error) {
          warn(error)
          return
        }
        if (skip) {
          // Oversized draft: keep it literal, and only clean up once.
          if (!sizeSkipped) {
            sizeSkipped = true
            sweepAll(root)
            cache.clear()
            recheck = new Set()
            lastCaretKey = null
          }
          return
        }
        sizeSkipped = false
        if (dom !== null) {
          try {
            for (let i = 0; i < dom.blocks.length; i += 1) {
              const block = dom.blocks[i]
              const key = block.node.getKey()
              if (!dom.toPaint.has(key)) continue
              paintBlock(editor, block, dom.analyses[i], dom.caretKey !== null && dom.caretKey === key)
            }
            allDirty = false
            lastCaretKey = dom.caretKey





          } catch (error) {
            warn(error)
          }
        }
        if (structural === null) {
          maybeHomeCaret(editor)
          recheck = new Set()
          recentWrites = []
          return
        }
        const now = Date.now()
        recentWrites = recentWrites.filter((time) => now - time < 1000)
        if (recentWrites.length >= MAX_WRITES_PER_SECOND) {
          log.warn('live rendering paused for a second (writes not converging)')
          return
        }
        recentWrites.push(now)
        try {
          editor.update(() => {
            if (structural.kind === 'normalize') {
              for (const block of structural.targets) {
                try {
                  promoteSoftLines(editor, block.node)
                } catch {
                  // A block detached by an earlier promotion is simply skipped.
                }
              }
              return
            }
            for (const plan of structural.plans) {
              try {
                applyShape(plan)
              } catch {
                // Stale plan: the next pass re-plans against the new state.
              }
            }
          }, { discrete: true, tag: HISTORY_MERGE_TAG })
        } catch (error) {
          warn(error)
        }
        recheck =
          structural.kind === 'normalize'
            ? (allDirty = true, new Set())
            : new Set(structural.plans.map((plan) => plan.block.node.getKey()))
        // Repaint in a microtask (before the browser paints) so a DOM element
        // reused by reconciliation never shows the previous block's styling.
        queueMicrotask(() => {
          if (!disposed) restyle(editor)
        })
      }

      /**
       * The collapsed caret in a marker leaf (click, arrow key, programmatic
       * placement). Typing or IME composition there would recolor/absorb the
       * marker glyph, so such a caret is homed to the nearest block boundary.
       */
      function caretInMarker(editor) {
        const key = caretBlockKey(editor)
        if (key === null) return null
        const blocks = readBlocks(editor)
        const block = blocks.find((candidate) => candidate.node.getKey() === key)
        if (block === undefined) return null
        const analysis = cache.get(key)
        if (analysis === undefined) return null
        const selection = liveSelection(editor)
        const anchor = selection?.anchor
        const focus = selection?.focus
        if (anchor == null || focus == null) return null
        if (anchor.type !== 'text' || anchor.key !== focus.key || anchor.offset !== focus.offset) return null
        for (const leaf of block.leaves) {
          if (leaf.node.getKey() !== anchor.key) continue
          if (leaf.kind !== 'text' || leaf.text.length === 0) return null
          const mark = analysis.markByStart.get(leaf.start)
          if (mark === undefined || mark.end !== leaf.start + leaf.text.length) return null
          // Only block markers are homed. Inline delimiters (`*`, backtick,
          // link brackets) must stay reachable with the arrow keys.
          if (!BLOCK_MARK_KINDS.has(mark.kind)) return null
          return { block, leaf, offset: Math.min(anchor.offset ?? 0, leaf.text.length) }
        }
        return null
      }

      function homeCaretInside(editor) {
        const found = caretInMarker(editor)
        if (found === null) return
        const { block, leaf, offset } = found
        const leaves = block.leaves
        const position = leaves.indexOf(leaf)
        const after = offset * 2 >= leaf.text.length
        // Prefer a real text leaf beside the marker: composition/typing there
        // keeps the normal text color while the marker stays dimmed.
        if (after && position >= 0) {
          const nextLeaf = leaves[position + 1]
          if (nextLeaf != null && nextLeaf.kind === 'text' && nextLeaf.text.length > 0) {
            const whitespaceOnly = /^[ \t]+$/.test(nextLeaf.text)
            const at = whitespaceOnly ? nextLeaf.text.length : 0
            nextLeaf.node.select(at, at)
            return
          }
        } else if (!after && position > 0) {
          const previousLeaf = leaves[position - 1]
          if (previousLeaf != null && previousLeaf.kind === 'text' && previousLeaf.text.length > 0) {
            previousLeaf.node.select(previousLeaf.text.length, previousLeaf.text.length)
            return
          }
        }
        if (typeof leaf.node.getIndexWithinParent !== 'function' || typeof block.node.select !== 'function') return
        const index = leaf.node.getIndexWithinParent()
        const target = after ? index + 1 : index
        block.node.select(target, target)
      }

      /** Commit one selection-only update when the caret sits in a marker. */
      function maybeHomeCaret(editor) {
        let needed = false
        try {
          editor.getEditorState().read(() => {
            needed = caretInMarker(editor) !== null
          })
        } catch {
          return
        }
        if (!needed) return
        try {
          editor.update(() => homeCaretInside(editor), { discrete: true, tag: HISTORY_MERGE_TAG })
        } catch (error) {
          warn(error)
        }
      }

      /** Coalesce bursts into one pass per animation frame. */
      function schedule(editor) {
        if (disposed || scanPending) return
        scanPending = true
        const run = () => {
          scanPending = false
          restyle(editor)
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
        else setTimeout(run, 16)
      }

      function wireEditor(editor) {
        if (disposed || wired.has(editor)) return
        try {
          const off = editor.registerUpdateListener(() => schedule(editor))
          wired.add(editor)
          unwires.add(off)
          schedule(editor)
        } catch (error) {
          warn(error)
        }
      }

      function wireAttempt() {
        const editor = resolveEditor()
        if (editor !== null) wireEditor(editor)
      }

      function onFocusIn(event) {
        const target = event.target
        if (!(target instanceof Node)) return
        if (target.closest?.(COMPOSER_INPUT) == null) return
        wireAttempt()
      }

      function intercept(event) {
        event.preventDefault()
        event.stopPropagation()
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
      }

      /**
       * Composer key assists:
       *
       * - Shift+Enter in a list item continues the list (same indentation and
       *   marker, ordered numbers advance); on an empty item it leaves the
       *   list; on an opening code fence it inserts the code body plus the
       *   closing fence and parks the caret in the body.
       * - Backspace at a list marker edge removes the marker (leaving plain
       *   text), and on the empty body line of a completed fence it removes
       *   the fence pair.
       *
       * Every other key keeps the host behavior.
       */
      function onKeyDown(event) {
        const isEnter = event.key === 'Enter'
        const isBackspace = event.key === 'Backspace'
        if (!isEnter && !isBackspace) return
        if (event.isComposing === true || event.altKey === true || event.ctrlKey === true || event.metaKey === true) return
        if (isEnter && event.shiftKey !== true) return
        if (isBackspace && event.shiftKey === true) return
        const root = document.querySelector(COMPOSER_INPUT)
        const target = event.target
        if (!(root instanceof HTMLElement) || !(target instanceof Node) || !root.contains(target)) return
        const editor = resolveEditor()
        if (editor === null) return
        let context = null
        try {
          editor.getEditorState().read(() => {
            const caretKey = caretBlockKey(editor)
            if (caretKey === null) return
            const blocks = readBlocks(editor)
            const index = blocks.findIndex((candidate) => candidate.node.getKey() === caretKey)
            if (index < 0) return
            const block = blocks[index]
            const selection = liveSelection(editor)
            const anchor = selection?.anchor
            const focus = selection?.focus
            const collapsed =
              anchor != null &&
              focus != null &&
              anchor.key === focus.key &&
              anchor.offset === focus.offset
            const offset = caretFlatOffset(block, anchor)
            if (offset === null) return
            context = {
              blocks,
              index,
              block,
              offset,
              collapsed,
              text: block.text,
              roles: classifyLines(blocks.map((candidate) => candidate.text)),
            }
          })
        } catch {
          return
        }
        if (context === null) return
        // Multi-block / range selection: leave Enter and Backspace to the host
        // so deleting a selected range removes every selected paragraph.
        if (!context.collapsed) return
        const { blocks, index, block, offset, text } = context
        const role = context.roles[index].role

        if (isEnter) {
          if (role === 'fence-open' && index === blocks.length - 1 && offset === text.length) {
            intercept(event)
            try {
              editor.update(() => completeFenceInside(editor, block.node), {
                discrete: true,
                tag: HISTORY_MERGE_TAG,
              })
            } catch (error) {
              warn(error)
            }
            return
          }
          if (EMPTY_LIST_RE.test(text) && offset >= text.length) {
            intercept(event)
            try {
              editor.update(() => removePrefixInside(block.node, text.length), {
                discrete: true,
                tag: HISTORY_MERGE_TAG,
              })
            } catch (error) {
              warn(error)
            }
            return
          }
          const quote = quoteContextOf(text)
          if (quote !== null) {
            if (EMPTY_QUOTE_RE.test(text) && offset >= text.length) {
              intercept(event)
              try {
                editor.update(() => removePrefixInside(block.node, text.length), {
                  discrete: true,
                  tag: HISTORY_MERGE_TAG,
                })
              } catch (error) {
                warn(error)
              }
              return
            }
            if (offset < quote.contentStart) return
            intercept(event)
            try {
              editor.update(
                () => insertContinuationInside(editor, block.node, ' '.repeat(quote.indent) + '> '),
                { discrete: true, tag: HISTORY_MERGE_TAG },
              )
            } catch (error) {
              warn(error)
            }
            return
          }
          const list = listContextOf(text)
          if (list === null || offset < list.contentStart) return
          let marker
          if (list.kind === 'ordered') {
            marker = ' '.repeat(list.indent) + String(list.number + 1) + list.delimiter + ' '
          } else if (list.kind === 'task') {
            marker = ' '.repeat(list.indent) + '- [ ] '
          } else {
            marker = ' '.repeat(list.indent) + list.bulletChar + ' '
          }
          intercept(event)
          try {
            editor.update(() => insertContinuationInside(editor, block.node, marker), {
              discrete: true,
              tag: HISTORY_MERGE_TAG,
            })
          } catch (error) {
            warn(error)
          }
          return
        }

        // Backspace.
        if (
          text === '' &&
          index > 0 &&
          index < blocks.length - 1 &&
          context.roles[index - 1].role === 'fence-open' &&
          context.roles[index + 1].role === 'fence-close'
        ) {
          intercept(event)
          try {
            editor.update(() => {
              const open = blocks[index - 1].node
              const close = blocks[index + 1].node
              if (typeof block.node.selectStart === 'function') block.node.selectStart()
              close.remove()
              open.remove()
            }, { discrete: true, tag: HISTORY_MERGE_TAG })
          } catch (error) {
            warn(error)
          }
          return
        }
        // A blank line inside a code fence: delete that line and move the caret
        // onto a fresh paragraph after the closing fence. The new paragraph is
        // produced by the editor's own text insertion + soft-break promotion so
        // no stale code-background frame is left behind.
        if (role === 'fence-body' && text === '') {
          intercept(event)
          try {
            editor.update(() => {
              let closeIndex = -1
              for (let i = index + 1; i < blocks.length; i += 1) {
                if (context.roles[i].role === 'fence-close') {
                  closeIndex = i
                  break
                }
              }
              const empty = block.node
              if (closeIndex > 0) {
                const close = blocks[closeIndex].node
                if (typeof close.selectEnd === 'function') close.selectEnd()
                const selection = liveSelection(editor)
                if (selection != null && typeof selection.insertText === 'function') {
                  // Split the (hidden) closing fence line: the text after the
                  // newline becomes a normal paragraph outside the fence.
                  selection.insertText('\n')
                  promoteSoftLines(editor, close)
                } else if (selection != null && typeof selection.insertParagraph === 'function') {
                  selection.insertParagraph()
                }
                empty.remove()
                return
              }
              const previous = empty.getPreviousSibling()
              empty.remove()
              if (previous != null && typeof previous.selectEnd === 'function') previous.selectEnd()
            }, { discrete: true, tag: HISTORY_MERGE_TAG })
          } catch (error) {
            warn(error)
          }
          return
        }
        const quote = quoteContextOf(text)
        if (quote !== null && offset <= quote.contentStart) {
          intercept(event)
          try {
            editor.update(() => removePrefixInside(block.node, quote.contentStart), {
              discrete: true,
              tag: HISTORY_MERGE_TAG,
            })
          } catch (error) {
            warn(error)
          }
          return
        }
        const list = listContextOf(text)
        if (list !== null && offset <= list.contentStart) {
          intercept(event)
          try {
            editor.update(() => removePrefixInside(block.node, list.contentStart), {
              discrete: true,
              tag: HISTORY_MERGE_TAG,
            })
          } catch (error) {
            warn(error)
          }
          return
        }
        if (EMPTY_LIST_RE.test(text)) {
          intercept(event)
          try {
            editor.update(() => removePrefixInside(block.node, text.length), {
              discrete: true,
              tag: HISTORY_MERGE_TAG,
            })
          } catch (error) {
            warn(error)
          }
        }
      }

      /**
       * Multi-line paste at the end of a list item or quote line keeps the
       * block prefix on every pasted line (ordered numbers advance), so pasted
       * paragraphs stay inside the same list/quote.
       */
      function onPaste(event) {
        const root = document.querySelector(COMPOSER_INPUT)
        const target = event.target
        if (!(root instanceof HTMLElement) || !(target instanceof Node) || !root.contains(target)) return
        const data = event.clipboardData ?? event.dataTransfer
        if (data == null || typeof data.getData !== 'function') return
        const raw = data.getData('text/plain')
        if (typeof raw !== 'string' || raw.indexOf('\n') < 0) return
        const editor = resolveEditor()
        if (editor === null) return
        let context = null
        try {
          editor.getEditorState().read(() => {
            const caretKey = caretBlockKey(editor)
            if (caretKey === null) return
            const blocks = readBlocks(editor)
            const block = blocks.find((candidate) => candidate.node.getKey() === caretKey)
            if (block === undefined) return
            const selection = liveSelection(editor)
            const anchor = selection?.anchor
            const focus = selection?.focus
            const collapsed =
              anchor != null &&
              focus != null &&
              anchor.key === focus.key &&
              anchor.offset === focus.offset
            if (!collapsed) return
            const offset = caretFlatOffset(block, anchor)
            if (offset === null || offset !== block.text.length) return
            const list = listContextOf(block.text)
            const quote = list === null ? quoteContextOf(block.text) : null
            if (list === null && quote === null) return
            if (list !== null && offset < list.contentStart) return
            if (quote !== null && offset < quote.contentStart) return
            context = { list, quote, text: raw.replace(/\r\n?/g, '\n') }
          })
        } catch {
          return
        }
        if (context === null) return
        const lines = context.text.split('\n')
        let prefixed = lines[0]
        for (let i = 1; i < lines.length; i += 1) {
          let marker = ''
          if (context.list !== null) {
            const list = context.list
            if (list.kind === 'ordered') {
              marker = ' '.repeat(list.indent) + String(list.number + i) + list.delimiter + ' '
            } else if (list.kind === 'task') {
              marker = ' '.repeat(list.indent) + '- [ ] '
            } else {
              marker = ' '.repeat(list.indent) + list.bulletChar + ' '
            }
          } else {
            marker = ' '.repeat(context.quote.indent) + '> '
          }
          prefixed += '\n' + marker + lines[i]
        }
        intercept(event)
        try {
          editor.update(() => {
            const selection = liveSelection(editor)
            if (selection != null && typeof selection.insertText === 'function') selection.insertText(prefixed)
          }, { discrete: true, tag: HISTORY_MERGE_TAG })
        } catch (error) {
          warn(error)
        }
      }

      return {
        wireAttempt,
        onFocusIn,
        onKeyDown,
        onPaste,
        dispose() {
          disposed = true
          const root = document.querySelector(COMPOSER_INPUT)
          if (root instanceof HTMLElement && root.hasAttribute('data-dml-spellcheck-root')) {
            root.removeAttribute('data-dml-spellcheck-root')
            root.removeAttribute('spellcheck')
          }
          for (const off of unwires) {
            try {
              off()
            } catch {
              // A disposed editor's disposer may already be gone.
            }
          }
          unwires.clear()
        },
      }
    }

    // =========================================================================
    // User message Markdown rendering: replace the shipped plain-text node
    // renderer for the `text` cell with the host's own Markdown renderer, so
    // mentions/skill chips and message actions keep their shipped renderers.
    // =========================================================================

    function markdownLabels(t) {
      return {
        code: {
          copyLabel: t('copy'),
          copiedLabel: t('copied'),
          toolbarLabels: {
            codeLabel: t('codeBlock.title'),
            wrapLabel: t('codeBlock.wrap'),
            unwrapLabel: t('codeBlock.unwrap'),
          },
        },
        footnotes: t('markdown.footnotes'),
      }
    }

    /**
     * The chat renderer treats a single newline as a soft break (rendered as a
     * space). User drafts keep their line breaks, so turn each line ending
     * outside fenced code into a Markdown hard break (two trailing spaces).
     */
    function hardenSoftBreaks(text) {
      if (text.indexOf('\n') < 0) return text
      const lines = text.split('\n')
      const out = []
      let fence = null
      let previous = null
      const isQuote = (line) => /^ {0,3}>[ \t]/.test(line)
      const isList = (line) => /^ *(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.test(line)
      const isHeading = (line) => /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)
      const isRule = (line) => /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)
      for (const line of lines) {
        const marker = /^ {0,3}([`~]{3,})/.exec(line)
        if (fence === null && marker !== null) {
          fence = marker[1][0]
          out.push(line)
          previous = null
          continue
        }
        if (fence !== null) {
          if (marker !== null && marker[1][0] === fence) fence = null
          out.push(line)
          continue
        }
        if (line.trim() === '') {
          out.push(line)
          previous = 'blank'
          continue
        }
        const kind = isQuote(line) ? 'quote' : isList(line) ? 'list' : 'plain'
        // A blockquote / list paragraph swallows the following plain line as a
        // lazy continuation in Markdown, which made sent messages look wrong.
        // A blank line closes that block so the renderer matches the composer.
        if ((previous === 'quote' || previous === 'list') && kind === 'plain' && !isHeading(line) && !isRule(line)) {
          out.push('')
        }
        out.push(line + '  ')
        previous = kind
      }
      return out.join('\n')
    }

    function createUserTextMarkdown() {
      return function UserTextMarkdown({ node, raw, t }) {
        const text =
          typeof raw === 'string' && raw.length > 0
            ? raw
            : (node?.data?.display ?? node?.data?.text ?? '')
        const labels = React.useMemo(() => markdownLabels(t), [t])
        const prepared = React.useMemo(() => hardenSoftBreaks(text), [text])
        const rendered = prepared.length > 0
        return React.createElement(
          'span',
          { className: 'dml-usermd', 'data-dml-usermd': '' },
          rendered
            ? React.createElement(MarkdownText, { text: prepared, labels })
            : null,
        )
      }
    }

    // =========================================================================
    // Styles
    // =========================================================================

    const CSS = `
[data-composer-input] {
  --dml-mark-ink: var(--dsw-alias-label-caption, rgba(127, 127, 127, 0.55));
  --dml-link-ink: var(--dsw-alias-state-business-primary, #247bbf);
  --dml-code-bg: #ECEEF0;
  --dml-code-block-bg: #ECEEF0;
}
[data-composer-input] .dml-line { position: relative; }
[data-composer-input] .dml-mark { color: var(--dml-mark-ink); font-weight: 400; font-style: normal; }
[data-composer-input] .dml-mark-on { opacity: 0.65; }
[data-composer-input] .dml-mark-off { font-size: 0 !important; letter-spacing: 0 !important; opacity: 0; }
/* Block-level markers render through a pseudo glyph in BOTH caret states, so
   the content after the marker never shifts horizontally when the caret moves
   onto the line (the raw "- " text is never revealed). */
[data-composer-input] .dml-mark-bullet,
[data-composer-input] .dml-mark-task-open,
[data-composer-input] .dml-mark-task-done {
  font-size: 0 !important;
  letter-spacing: 0 !important;
  opacity: 1 !important;
}
[data-composer-input] .dml-mark-bullet::before,
[data-composer-input] .dml-mark-task-open::before,
[data-composer-input] .dml-mark-task-done::before {
  font-size: var(--dsh-content-font-size, 14px);
  color: var(--dsw-alias-label-secondary);
  display: inline-block;
  text-indent: 0;
  width: 0.42em;
  text-align: center;
}
[data-composer-input] .dml-mark-bullet::before { content: "\\2022"; }
[data-composer-input] .dml-mark-task-open::before { content: "\\2610"; width: 1.3em; }
[data-composer-input] .dml-mark-task-done::before { content: "\\2611"; width: 1.3em; }
[data-composer-input] .dml-lvl-1 { padding-left: 22px; }
[data-composer-input] .dml-lvl-2 { padding-left: 44px; }
[data-composer-input] .dml-lvl-3 { padding-left: 66px; }
[data-composer-input] .dml-lvl-4 { padding-left: 88px; }
[data-composer-input] .dml-lvl-5 { padding-left: 110px; }
[data-composer-input] .dml-lvl-2 .dml-mark-bullet::before { content: "\\25E6"; }
[data-composer-input] .dml-lvl-3 .dml-mark-bullet::before { content: "\\25AA"; }
[data-composer-input] .dml-lvl-4 .dml-mark-bullet::before,
[data-composer-input] .dml-lvl-5 .dml-mark-bullet::before { content: "\\25AB"; }

/* Ordered numbers stay visible in both states: identical width, no shift. */
[data-composer-input] .dml-mark-ordered.dml-mark-off,
[data-composer-input] .dml-mark-fence.dml-mark-off {
  font-size: inherit !important;
  opacity: 0.55;
}
/* Quote / heading markers are purely structural: hidden in both states. */
[data-composer-input] .dml-mark-quote,
[data-composer-input] .dml-mark-heading {
  font-size: 0 !important;
  letter-spacing: 0 !important;
  opacity: 0;
}
[data-composer-input] .dml-task { color: var(--dsw-alias-label-secondary); }
[data-composer-input] .dml-mark-fence.dml-mark-off { opacity: 0.3; }
[data-composer-input] .dml-h1 { font-size: 1.62em; font-weight: 700; line-height: 1.38; }
[data-composer-input] .dml-h2 { font-size: 1.42em; font-weight: 700; line-height: 1.4; }
[data-composer-input] .dml-h3 { font-size: 1.24em; font-weight: 650; line-height: 1.42; }
[data-composer-input] .dml-h4 { font-size: 1.12em; font-weight: 600; line-height: 1.45; }
[data-composer-input] .dml-h5 { font-size: 1.04em; font-weight: 600; }
[data-composer-input] .dml-h6 { font-size: 0.98em; font-weight: 600; color: var(--dsw-alias-label-secondary); }
[data-composer-input] .dml-quote {
  border-left: 3px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35));
  padding-left: 10px;
  color: var(--dsw-alias-label-secondary);
}
[data-composer-input] .dml-fence-body {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.92em;
  background: var(--dml-code-block-bg);
  margin: 0 !important;
  padding: 0 10px;
  line-height: 1.55;
  min-height: 1.55em;
  border-radius: 0;
}
/* Only the first and last code lines carry the outer rounding, so a multi-line
   block keeps a single continuous rounded rectangle. */
[data-composer-input] .dml-fence-open + .dml-fence-body {
  border-top-left-radius: 10px;
  border-top-right-radius: 10px;
}
[data-composer-input] .dml-fence-body:has(+ .dml-fence-close) {
  border-bottom-left-radius: 10px;
  border-bottom-right-radius: 10px;
}
[data-composer-input] .dml-fence-body,
[data-composer-input] .dml-fence-body * { white-space: pre-wrap; }
[data-composer-input] .dml-fence-open,
[data-composer-input] .dml-fence-close {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.86em;
  margin: 0 !important;
  padding: 0 10px;
}
/* Fence marker lines collapse to nothing unless the caret is on them, so the
   code block reads as one continuous block instead of showing fence markers. */
[data-composer-input] .dml-fence-open:not(.dml-caret),
[data-composer-input] .dml-fence-close:not(.dml-caret) {
  height: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  background: transparent !important;
  border: 0 !important;
}
[data-composer-input] .dml-fence-open.dml-caret,
[data-composer-input] .dml-fence-close.dml-caret {
  background: transparent !important;
  opacity: 0.85;
}
[data-composer-input] .dml-hr { min-height: 16px; }
[data-composer-input] .dml-hr::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  background: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.4));
  pointer-events: none;
}
[data-composer-input] .dml-hr .dml-mark-off { font-size: 0 !important; opacity: 0; }
[data-composer-input] .dml-link {
  color: var(--dml-link-ink);
  text-decoration: underline;
  text-underline-offset: 2px;
}
[data-composer-input] code {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.92em;
  background: var(--dml-code-bg);
  border-radius: 7px;
  padding: 1px 5px;
}
[data-composer-input] .dml-line.dml-caret:not(.dml-fence-body) { background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-primary, #ffffff)); }
.dml-usermd { display: block; white-space: normal; text-align: left; }
.dml-usermd > div { margin: 0; }
.dml-usermd p:first-child { margin-top: 0; }
.dml-usermd p:last-child { margin-bottom: 0; }
`

    const LOCALE = {
      en: {
        copy: 'Copy',
        copied: 'Copied',
        codeBlock: {
          title: 'Code',
          wrap: 'Wrap lines',
          unwrap: 'Unwrap lines',
        },
        markdown: {
          footnotes: 'Footnotes',
        },
      },
      zh: {
        copy: '复制',
        copied: '已复制',
        codeBlock: {
          title: '代码',
          wrap: '自动换行',
          unwrap: '取消换行',
        },
        markdown: {
          footnotes: '脚注',
        },
      },
    }

    // =========================================================================
    // Plugin entry
    // =========================================================================

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        const log = {
          warn(...args) {
            try {
              console.warn('[dsh-markdown-live]', ...args)
            } catch {
              // console unavailable: nothing to report to
            }
          },
        }

        // Drop diagnostics left by a development build of this plugin.
        const staleDebug = document.getElementById('dml-debug')
        if (staleDebug !== null) staleDebug.remove()

        // Stylesheet, removed with the plugin.
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.dshMarkdownLive = ''
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'dsh-markdown-live: stylesheet')

        // Markdown chrome labels for the host's own renderer.
        ctx.effect(() => ctx.locale.register(NS, LOCALE), 'dsh-markdown-live: dictionaries')

        // Sent user messages render Markdown in place of the plain text node.
        const UserTextMarkdown = createUserTextMarkdown()
        ctx.slots.inject('conversation.user.text.node', () =>
          ctx.slots.register({
            name: 'conversation.user.text.node',
            key: 'text',
            // The slot renders the LOWEST priority entry for a key; the
            // shipped plain-text renderer sits at 100, so shadow it below.
            priority: -1,
            locale: NS,
          }, UserTextMarkdown),
        )

        // Live composer rendering.
        const renderer = createLiveRenderer(log)
        renderer.wireAttempt()
        document.addEventListener('focusin', renderer.onFocusIn, true)
        document.addEventListener('keydown', renderer.onKeyDown, true)
        document.addEventListener('paste', renderer.onPaste, true)
        // A composer can mount without ever receiving focus (restored session,
        // new session panel): poll for the editor instance and wire it.
        const poll = setInterval(renderer.wireAttempt, 500)
        ctx.effect(() => () => {
          clearInterval(poll)
          document.removeEventListener('focusin', renderer.onFocusIn, true)
          document.removeEventListener('keydown', renderer.onKeyDown, true)
          document.removeEventListener('paste', renderer.onPaste, true)
          renderer.dispose()
          const root = document.querySelector(COMPOSER_INPUT)
          if (root instanceof HTMLElement) {
            for (const el of root.querySelectorAll('[class*="dml-"]')) {
              if (el instanceof HTMLElement) stripClasses(el)
            }
          }
        }, 'dsh-markdown-live: live renderer')
      },
    }
  },
})
