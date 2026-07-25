"""Sphinx configuration for the Conda Code documentation."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).parent.parent
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

project = html_title = "Conda Code"
copyright = "2026, Jannis Leidel"
author = "Jannis Leidel"
release = PACKAGE["version"]
version = release

extensions = [
    "myst_parser",
    "sphinx_copybutton",
    "sphinx_design",
    "sphinx_sitemap",
]

myst_enable_extensions = [
    "colon_fence",
    "deflist",
    "fieldlist",
]

html_theme = "conda_sphinx_theme"

html_theme_options = {
    "icon_links": [
        {
            "name": "GitHub",
            "url": "https://github.com/jezdez/conda-code",
            "icon": "fa-brands fa-square-github",
            "type": "fontawesome",
        },
    ],
}

html_context = {
    "github_user": "jezdez",
    "github_repo": "conda-code",
    "github_version": "main",
    "doc_path": "docs",
}

html_baseurl = "https://jezdez.github.io/conda-code/"
html_extra_path = ["robots.txt"]
sitemap_url_scheme = "{link}"

exclude_patterns = ["_build"]
