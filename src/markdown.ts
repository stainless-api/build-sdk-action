export const Symbol = {
  Bulb: "💡",
  Exclamation: "❗",
  GreenSquare: "🟩",
  HeavyAsterisk: "✱",
  MiddleDot: "·",
  RedSquare: "🟥",
  RightwardsArrow: "→",
  SpeechBalloon: "💬",
  Warning: "⚠️",
  WhiteCheckMark: "✅",
  WhiteLargeSquare: "⬜",
  Zap: "⚡",
};

export const Bold = (content: string) => `<b>${content}</b>`;

export const CodeInline = (content: string) => `<code>${content}</code>`;

export const Italic = (content: string) => `<i>${content}</i>`;

export function Dedent(value: string): string {
  value = value.replace(/\r?\n([\t ]*)$/, "");

  const indentLengths = value
    .match(/\n([\t ]+|(?!\s).)/g)
    ?.map((match) => match.match(/[\t ]/g)?.length ?? 0);

  if (indentLengths && indentLengths.length > 0) {
    const pattern = new RegExp(`\n[\t ]{${Math.min(...indentLengths)}}`, "g");
    value = value.replace(pattern, "\n");
  }

  value = value.replace(/^\r?\n/, "");

  return value;
}

export const Blockquote = (content: string) =>
  `<blockquote>${content}</blockquote>`;

export const CodeBlock = (
  props: string | { content: string; language?: string },
): string => {
  const delimiter = "```";
  const content = typeof props === "string" ? props : props.content;
  const language = typeof props === "string" ? "" : props.language;

  return Dedent(`
    ${delimiter}${language}
    ${content}
    ${delimiter}
  `);
};

export const Details = ({
  summary,
  body,
  open = false,
}: {
  summary: string;
  body: string;
  open?: boolean;
}) => {
  return Dedent(`
    <details${open ? " open" : ""}>
      <summary>${summary}</summary>

      ${body}

    </details>
  `);
};

export const Heading = (content: string) => `<h3>${content}</h3>`;

export const Link = ({ text, href }: { text: string; href: string }) =>
  `<a href="${href}">${text}</a>`;

export const List = (lines: string[]) => {
  return Dedent(`
    <ul>
    ${lines.map((line) => `  <li>${line}</li>`).join("\n")}
    </ul>
  `);
};

export const Rule = () => `<hr />`;
