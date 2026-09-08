import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
from string import Template
from urllib.parse import quote, unquote, urlsplit

from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "docs/site"
OUTPUT = ROOT / ".build/pages/mutter"
BASE = "/mutter/"
REPOSITORY = "https://github.com/alaarab/mutter"
PAGES = json.loads((SITE / "pages.json").read_text())
ROUTES = {source: destination for _, _, source, destination in PAGES}
ASSETS = {"docs/brand/icon.svg": "assets/icon.svg"}
ASSETS.update(
    (str(path.relative_to(ROOT)), f"assets/screenshots/{path.name}")
    for path in (ROOT / "docs/images/phone-layout").glob("*.png")
)


def resolve_link(source, value):
    url = urlsplit(value)
    if url.scheme or url.netloc or value.startswith(("#", "/")):
        return value
    target = (ROOT / source).parent.joinpath(unquote(url.path)).resolve()
    relative = target.relative_to(ROOT).as_posix()
    suffix = (f"?{url.query}" if url.query else "") + (
        f"#{url.fragment}" if url.fragment else ""
    )
    if relative in ROUTES:
        return BASE + ROUTES[relative] + suffix
    if relative in ASSETS:
        return BASE + ASSETS[relative] + suffix
    if not target.exists():
        raise ValueError(f"{source}: missing link target {value}")
    kind = "tree" if target.is_dir() else "blob"
    return f"{REPOSITORY}/{kind}/main/{quote(relative)}{suffix}"


class Document(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.parts = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        for name in ("href", "src"):
            if name in values:
                values[name] = resolve_link(self.source, values[name])
        if tag == "img":
            values["loading"] = "lazy"
            if not values.get("alt"):
                raise ValueError(f"{self.source}: image needs alt text")
        attributes = "".join(
            f' {name}="{html.escape(value, quote=True)}"'
            if value is not None
            else f" {name}"
            for name, value in values.items()
        )
        self.parts.append(f"<{tag}{attributes}>")

    def handle_endtag(self, tag):
        self.parts.append(f"</{tag}>")

    def handle_data(self, data):
        self.parts.append(data)

    def handle_entityref(self, name):
        self.parts.append(f"&{name};")

    def handle_charref(self, name):
        self.parts.append(f"&#{name};")


class PageLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.links = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if "id" in values:
            if values["id"] in self.ids:
                raise ValueError(f"Duplicate page ID: {values['id']}")
            self.ids.add(values["id"])
        self.links.extend(values[name] for name in ("href", "src") if name in values)


def validate():
    pages = {}
    for path in OUTPUT.glob("*.html"):
        page = PageLinks()
        page.feed(path.read_text())
        pages[path.name] = page
    for name, page in pages.items():
        for value in page.links:
            url = urlsplit(value)
            if url.scheme or url.netloc:
                continue
            target = unquote(url.path).removeprefix(BASE) or name
            if url.path == BASE:
                target = "index.html"
            if not (OUTPUT / target).is_file():
                raise ValueError(f"{name}: missing published file {value}")
            if (
                url.fragment
                and target in pages
                and unquote(url.fragment) not in pages[target].ids
            ):
                raise ValueError(f"{name}: missing heading {value}")


def navigation(current):
    result, previous = [], None
    for group, title, _, destination in PAGES:
        if group != previous:
            result.append(f'<p class="nav-group">{group}</p>')
            previous = group
        selected = ' aria-current="page"' if destination == current else ""
        result.append(
            f'<a href="{BASE}{destination}"{selected}>{html.escape(title)}</a>'
        )
    return "".join(result)


def build():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for path in OUTPUT.iterdir():
        shutil.rmtree(path) if path.is_dir() else path.unlink()
    for source, destination in ASSETS.items():
        target = OUTPUT / destination
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / source, target)
    fonts = OUTPUT / "assets/fonts"
    fonts.mkdir()
    for name in (
        "BricolageDisplay-Bold.ttf",
        "PlusJakartaSans-Regular.ttf",
        "PlusJakartaSans-SemiBold.ttf",
        "OFL-Bricolage.txt",
        "OFL-PlusJakartaSans.txt",
    ):
        shutil.copy2(ROOT / "design/fonts" / name, fonts / name)
    for name in ("site.css", "site.js"):
        shutil.copy2(SITE / name, OUTPUT / "assets" / name)
    palettes = json.loads(
        (ROOT / "android/app/src/main/assets/themes.json").read_text()
    )["themes"]["carbon"]
    declarations = {
        mode: ";".join(
            f"--{key}:{value}"
            for key, value in palette.items()
            if isinstance(value, str) and value.startswith("#")
        )
        for mode, palette in palettes.items()
        if mode in ("light", "dark")
    }
    (OUTPUT / "assets/palette.css").write_text(
        ":root{color-scheme:light;"
        + declarations["light"]
        + "}\n"
        + '@media(prefers-color-scheme:dark){:root:not([data-appearance="light"]){color-scheme:dark;'
        + declarations["dark"]
        + "}}\n"
        + ':root[data-appearance="dark"]{color-scheme:dark;'
        + declarations["dark"]
        + "}\n"
    )
    markdown = MarkdownIt("commonmark", {"html": True}).enable(
        ["table", "strikethrough"]
    )
    template = Template((SITE / "page.html").read_text())
    for _, title, source, destination in PAGES:
        tokens = markdown.parse((ROOT / source).read_text())
        seen, contents = {}, []
        for index, token in enumerate(tokens):
            if token.type != "heading_open":
                continue
            text = tokens[index + 1].content
            slug = re.sub(r"[^\w\- ]", "", text.lower()).replace(" ", "-")
            count = seen.get(slug, 0)
            seen[slug] = count + 1
            anchor = f"{slug}-{count}" if count else slug
            token.attrSet("id", anchor)
            if token.tag == "h2":
                contents.append(f'<a href="#{anchor}">{html.escape(text)}</a>')
        document = Document(source)
        document.feed(markdown.renderer.render(tokens, markdown.options, {}))
        page = template.substitute(
            title=html.escape(title),
            base=BASE,
            repository=REPOSITORY,
            navigation=navigation(destination),
            contents="".join(contents),
            content="".join(document.parts),
            source=quote(source),
            canonical=f"https://alaarab.github.io{BASE}{destination if destination != 'index.html' else ''}",
        )
        (OUTPUT / destination).write_text(page)
    (OUTPUT / ".nojekyll").touch()
    validate()
    print(f"Built and checked {len(PAGES)} pages in {OUTPUT}")


if __name__ == "__main__":
    build()
