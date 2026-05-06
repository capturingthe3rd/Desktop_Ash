// Cleans an agent's natural-language response for display in a bubble.
// Strips common markdown noise so bubbles read like prose instead of source text,
// then keeps just the first paragraph (or first sentence if it's still long).
// Truncation past max chars happens AFTER tidying so the 200-char budget applies
// to the readable text, not raw markdown like "**bold** at the start was here…".

const MAX_BUBBLE_CHARS = 200;

export function tidyMessage(raw: string): string {
  if (!raw) return "";

  let s = raw;

  // Remove fenced code blocks entirely (rarely useful in a small bubble)
  s = s.replace(/```[\s\S]*?```/g, " ");

  // Inline code: keep the content, drop the backticks
  s = s.replace(/`([^`\n]+)`/g, "$1");

  // Headers: drop the leading hashes + space
  s = s.replace(/^#+\s+/gm, "");

  // Bold / italic markers: keep the inner text
  s = s.replace(/\*\*(.+?)\*\*/g, "$1");
  s = s.replace(/__(.+?)__/g, "$1");
  s = s.replace(/(^|\W)\*([^\s*][^*\n]*?)\*(\W|$)/g, "$1$2$3");
  s = s.replace(/(^|\W)_([^\s_][^_\n]*?)_(\W|$)/g, "$1$2$3");

  // Bullet markers → middot for compactness
  s = s.replace(/^\s*[-*+]\s+/gm, "• ");

  // Numbered list markers
  s = s.replace(/^\s*\d+\.\s+/gm, "");

  // Markdown links: [text](url) → text
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

  // Horizontal rules
  s = s.replace(/^[-*_]{3,}\s*$/gm, " ");

  // Collapse runs of whitespace within a line, but preserve paragraph breaks
  s = s
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0)
    .join("\n\n");

  s = s.trim();
  if (!s) return "";

  // Take just the first paragraph
  const firstPara = s.split(/\n\s*\n/)[0]?.trim() ?? s;

  // If the first paragraph is still too long, take the first sentence boundary
  // past 60 chars so we don't end mid-thought.
  let result = firstPara;
  if (result.length > MAX_BUBBLE_CHARS) {
    const sentenceMatch = result.match(/^.{60,}?[.!?](\s|$)/);
    if (sentenceMatch) {
      result = sentenceMatch[0].trim();
    }
  }

  // Final truncate with ellipsis if still over budget
  if (result.length > MAX_BUBBLE_CHARS) {
    result = result.slice(0, MAX_BUBBLE_CHARS - 1) + "…";
  }

  return result;
}
