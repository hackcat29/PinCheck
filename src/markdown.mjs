// Minimal Markdown for the repository's own docs: headings, paragraphs, lists, tables, fences, inline code, links, emphasis.
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const slug = text => text.toLowerCase().replace(/<[^>]+>|`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function inline(text) {
  const codes = [];
  let html = escape(text).replace(/`([^`]+)`/g, (_, code) => { codes.push(code); return '\u0000' + (codes.length - 1) + '\u0000'; });
  html = html
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      const safe = /^(https?:\/\/|\/|#|\.\.?\/)/.test(href) ? href : '#';
      const external = /^https?:/.test(safe);
      return '<a href="' + safe + '"' + (external ? ' rel="noopener"' : '') + '>' + label + '</a>';
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[i] + '</code>');
}

export function renderMarkdown(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const toc = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push('<div class="code"><pre tabindex="0"' + (lang ? ' data-lang="' + escape(lang) + '"' : '') + '><code>' + escape(body.join('\n')) + '</code></pre><button type="button" class="copy" data-copy>Copy</button></div>');
    } else if (/^#{1,4} /.test(line)) {
      const level = line.match(/^#+/)[0].length;
      const text = line.slice(level + 1).trim();
      const id = slug(text);
      if (level === 2) toc.push({ id, text: text.replace(/`/g, '') });
      out.push('<h' + level + ' id="' + id + '">' + inline(text) + '</h' + level + '>');
      i++;
    } else if (/^\|/.test(line)) {
      const rows = [];
      for (; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(lines[i].replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|')));
      const [head, , ...body] = rows;
      out.push('<div class="table"><table><thead><tr>' + head.map(c => '<th scope="col">' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
        + body.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
    } else if (/^(\d+\.|-) /.test(line)) {
      const ordered = /^\d+\./.test(line);
      const items = [];
      for (; i < lines.length && (/^(\d+\.|-) /.test(lines[i]) || /^ {2,}\S/.test(lines[i])); i++) {
        if (/^ {2,}\S/.test(lines[i])) items[items.length - 1] += ' ' + lines[i].trim();
        else items.push(lines[i].replace(/^(\d+\.|-) /, ''));
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push('<' + tag + '>' + items.map(item => '<li>' + inline(item) + '</li>').join('') + '</' + tag + '>');
    } else if (/^> /.test(line)) {
      const quote = [];
      for (; i < lines.length && /^> ?/.test(lines[i]); i++) quote.push(lines[i].replace(/^> ?/, ''));
      out.push('<aside class="note"><p>' + inline(quote.join(' ')) + '</p></aside>');
    } else if (line.trim() === '') {
      i++;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() !== '' && !/^(#{1,4} |```|\||(\d+\.|-) |> )/.test(lines[i]); i++) para.push(lines[i].trim());
      out.push('<p>' + inline(para.join(' ')) + '</p>');
    }
  }
  return { html: out.join('\n'), toc };
}
