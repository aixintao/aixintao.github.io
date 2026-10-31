"""把 posts 目录里的 Markdown 生成博客页面。

新建文章，保存为 posts/2026-10-13-slug.md：

---
title: 标题
date: 2026-10-13
summary: 可选。不写的话，用正文开头做摘要
---

正文使用 Markdown。图片放在 posts 里，用相对路径引用。

写完后在仓库根目录运行：

    python build_blog.py
"""

from __future__ import annotations

import html
import re
from datetime import date, datetime
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent
POSTS = ROOT / "posts"
BLOG = ROOT / "blog"
HOME = ROOT / "index.html"
MANIFEST = BLOG / ".generated"
SITE = "https://aixintao.github.io"
DATE_NAME = re.compile(r"^(\d{4}-\d{2}-\d{2})-(.+)$")
HOME_SLOT = re.compile(r"<!-- posts:start -->.*?<!-- posts:end -->", re.S)
ASSET_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp4", ".mp3")


def parse_date(value: str, source: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as error:
        raise SystemExit(f"{source} 的日期需要写成 YYYY-MM-DD，现在是 {value}") from error


def split_front_matter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    meta: dict[str, str] = {}
    for line in parts[1].strip().splitlines():
        if not line.strip() or ":" not in line:
            continue
        key, value = line.split(":", 1)
        meta[key.strip().lower()] = value.strip().strip("\"'")
    return meta, parts[2].lstrip("\n")


def excerpt_from(body: str, limit: int = 72) -> str:
    chunks: list[str] = []
    in_code = False
    for raw in body.splitlines():
        line = raw.strip()
        if line.startswith("```"):
            in_code = not in_code
            if chunks:
                break
            continue
        if in_code or not line or line.startswith(("#", ">", "!")):
            if chunks:
                break
            continue
        chunks.append(line)
        if sum(len(item) for item in chunks) >= limit:
            break
    text = " ".join(chunks)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*_`]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[:limit].rstrip() + "…"
    return text


def load_posts() -> list[dict]:
    if not POSTS.exists():
        return []
    posts = []
    slugs = set()
    for path in sorted(POSTS.glob("*.md")):
        meta, body = split_front_matter(path.read_text(encoding="utf-8"))
        stem = path.stem
        matched = DATE_NAME.match(stem)
        if matched:
            file_date, slug = matched.group(1), matched.group(2)
        else:
            file_date, slug = "", stem
        if not re.fullmatch(r"[0-9A-Za-z\u4e00-\u9fff][0-9A-Za-z\u4e00-\u9fff_-]*", slug):
            raise SystemExit(f"{path.name} 的文件名只能包含中文、字母、数字、下划线和连字符")
        if slug in slugs:
            raise SystemExit(f"文章地址重复：{slug}")
        slugs.add(slug)
        raw_date = meta.get("date") or file_date
        if not raw_date:
            raise SystemExit(f"{path.name} 缺少 date，或把日期写进文件名")
        title = meta.get("title") or slug
        summary = meta.get("summary") or excerpt_from(body)
        posts.append(
            {
                "title": title,
                "date": parse_date(raw_date, path.name),
                "summary": summary,
                "slug": slug,
                "body": body,
                "source": path.name,
            }
        )
    posts.sort(key=lambda item: item["date"], reverse=True)
    return posts


def rewrite_assets(rendered: str) -> str:
    def replace(match: re.Match) -> str:
        attr, url = match.group(1), match.group(2)
        if url.startswith(("http://", "https://", "mailto:", "#", "/")):
            return match.group(0)
        if attr == "href" and not url.lower().split("?", 1)[0].endswith(ASSET_EXT):
            return match.group(0)
        return f'{attr}="../posts/{url.removeprefix("./")}"'

    return re.sub(r'(src|href)="([^"]+)"', replace, rendered)


def render_markdown(body: str) -> str:
    rendered = markdown.markdown(
        body,
        extensions=["extra", "sane_lists"],
        output_format="html",
    )
    return rewrite_assets(rendered)


def display_date(value: date) -> str:
    return f"{value.year}.{value.month}.{value.day}"


def shell(title: str, description: str, main: str, current: str = "") -> str:
    def item(href: str, label: str, key: str) -> str:
        current_attr = ' aria-current="page"' if key == current else ""
        return f'<li><a href="{href}"{current_attr}>{label}</a></li>'

    nav = "\n        ".join(
        [
            item("/blog/", "博客", "blog"),
            item("/#works", "作品", "works"),
            item("/#contact", "联系", "contact"),
            item("/#names", "时间线", "names"),
            item("/#guestbook", "留言", "guestbook"),
        ]
    )
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)}</title>
  <meta name="description" content="{html.escape(description)}">
  <meta name="theme-color" content="#12100e">
  <link rel="icon" href="/avatars/favicon.png">
  <link rel="stylesheet" href="/style.css">
  <link rel="alternate" type="application/rss+xml" title="aixintao" href="/blog/feed.xml">
</head>
<body class="page">
  <header class="wrap">
    <nav class="nav" aria-label="页面">
      <a class="brand" href="/#top">aixintao</a>
      <ul class="nav-links">
        {nav}
      </ul>
    </nav>
  </header>
  <main class="wrap page-main">
    {main}
  </main>
  <footer>
    <div class="wrap">aixintao · acrossT.</div>
  </footer>
</body>
</html>
"""


def post_items(posts: list[dict], href_for) -> str:
    rows = []
    for post in posts:
        rows.append(
            "\n".join(
                [
                    "  <li>",
                    f'    <time datetime="{post["date"].isoformat()}">{display_date(post["date"])}</time>',
                    "    <div>",
                    f'      <a class="post-title" href="{href_for(post)}">{html.escape(post["title"])}</a>',
                    f'      <p>{html.escape(post["summary"])}</p>' if post["summary"] else "",
                    "    </div>",
                    "  </li>",
                ]
            )
        )
    return '<ol class="post-list">\n' + "\n".join(rows) + "\n</ol>"


def home_block(posts: list[dict]) -> str:
    if not posts:
        inner = '<p class="empty">还没有文章。</p>'
    else:
        shown = posts[:3]
        inner = post_items(shown, lambda post: f'/blog/{post["slug"]}.html')
        inner += '\n<p class="more"><a href="/blog/">全部文章</a></p>'
    return f"<!-- posts:start -->\n{inner}\n<!-- posts:end -->"


def blog_index(posts: list[dict]) -> str:
    if posts:
        listing = post_items(posts, lambda post: f'{post["slug"]}.html')
    else:
        listing = '<p class="empty">还没有文章。</p>'
    main = "\n".join(
        [
            "<h1>博客</h1>",
            '<p class="article-meta">aixintao · acrossT.</p>',
            listing,
        ]
    )
    return shell("博客 · aixintao", "aixintao 的博客", main, current="blog")


def article_page(post: dict) -> str:
    main = "\n".join(
        [
            '<a class="back" href="/blog/">返回博客</a>',
            f"<h1>{html.escape(post['title'])}</h1>",
            f'<p class="article-meta"><time datetime="{post["date"].isoformat()}">{display_date(post["date"])}</time></p>',
            f'<article class="prose">\n{render_markdown(post["body"])}\n</article>',
        ]
    )
    description = post["summary"] or post["title"]
    return shell(
        f'{post["title"]} · aixintao',
        description,
        main,
        current="blog",
    )


def feed(posts: list[dict]) -> str:
    items = []
    for post in posts:
        link = f"{SITE}/blog/{post['slug']}.html"
        content = render_markdown(post["body"]).replace("]]>", "]]]]><![CDATA[>")
        items.append(
            "\n".join(
                [
                    "    <item>",
                    f"      <title>{html.escape(post['title'])}</title>",
                    f"      <link>{link}</link>",
                    f"      <guid>{link}</guid>",
                    f"      <pubDate>{post['date'].strftime('%a, %d %b %Y 00:00:00 +0000')}</pubDate>",
                    f"      <description><![CDATA[{content}]]></description>",
                    "    </item>",
                ]
            )
        )
    body = "\n".join(items)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>aixintao</title>
    <link>{SITE}/blog/</link>
    <description>aixintao 的博客</description>
{body}
  </channel>
</rss>
"""


def clean_generated() -> None:
    if not MANIFEST.exists():
        return
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        path = ROOT / line
        if path.is_file() and path.resolve().parent == BLOG.resolve():
            path.unlink()


def write_home(posts: list[dict]) -> None:
    text = HOME.read_text(encoding="utf-8")
    if not HOME_SLOT.search(text):
        raise SystemExit("index.html 里找不到 <!-- posts:start -->")
    updated = HOME_SLOT.sub(home_block(posts), text)
    HOME.write_text(updated, encoding="utf-8")


def main() -> None:
    posts = load_posts()
    BLOG.mkdir(exist_ok=True)
    clean_generated()
    generated = []

    index_name = "blog/index.html"
    (BLOG / "index.html").write_text(blog_index(posts), encoding="utf-8")
    generated.append(index_name)

    for post in posts:
        name = f"blog/{post['slug']}.html"
        (BLOG / f"{post['slug']}.html").write_text(article_page(post), encoding="utf-8")
        generated.append(name)

    feed_name = "blog/feed.xml"
    (BLOG / "feed.xml").write_text(feed(posts), encoding="utf-8")
    generated.append(feed_name)

    MANIFEST.write_text("\n".join(generated) + "\n", encoding="utf-8")
    write_home(posts)
    print(f"已生成 {len(posts)} 篇文章")


if __name__ == "__main__":
    main()
