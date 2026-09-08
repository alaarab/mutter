# Publishing the docs

The documentation lives at [alaarab.github.io/mutter](https://alaarab.github.io/mutter/).
Changes to the docs on `main` rebuild and publish the site through the Pages workflow.

Edit the Markdown files in the repository. The site and GitHub use the same text and screenshots.
The page list in `docs/site/pages.json` controls navigation and the public URLs. Links between
published guides become site links; links to source files lead back to GitHub.

## Preview locally

From the repository root, with Python 3.10 or newer:

```sh
python3 -m venv .build/docs-venv
.build/docs-venv/bin/pip install -r docs/site/requirements.txt
.build/docs-venv/bin/python scripts/build-docs.py
python3 -m http.server 8099 --directory .build/pages --bind 127.0.0.1
```

Open `http://localhost:8099/mutter/`. The build writes only to `.build/pages/mutter/`.
The published artifact contains the selected guides, screenshots, shared fonts, and site assets.

## Appearance

The site uses Mutter’s generated Carbon palette and the fonts in `design/fonts`. It follows the
system appearance by default; the theme button also offers light and dark. The preference stays
in the reader’s browser. Backgrounds, navigation, and links stay monochrome. Update the shared
palette through the usual theme generator.

## Deployment

The workflow in `.github/workflows/pages.yml` builds the site, uploads the Pages artifact,
and deploys it to the `github-pages` environment. Pull requests build the docs without deploying.
The workflow can also be run manually from GitHub Actions.

After publishing, check the home page, the phone layout guide, and at least one platform guide.
Check that screenshots load and the navigation works on a narrow screen.
