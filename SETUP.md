# Kristian Cimò Portfolio — CMS Package

This package contains all the files for the portfolio site with content-management capability.

## Folder Structure

```
/
├── index.html              # main site (loads content from /data via JS)
├── admin/
│   ├── index.html          # Sveltia CMS entry point — visit /admin to edit
│   └── config.yml          # CMS field definitions
├── data/                   # all editable content (managed by CMS)
│   ├── site.json           # hero, status, location
│   ├── projects.json       # all projects in the work grid
│   ├── case-study.json     # featured case study
│   ├── backstage.json      # backstage videos
│   ├── about.json          # about section
│   ├── footer.json         # footer / contact
│   └── clients.json        # clients marquee
└── media/                  # uploaded images/videos go here
```

## How to use the CMS

1. Visit `kristiancimo.netlify.app/admin`
2. Login with GitHub
3. Edit content → click Save
4. Wait ~30 seconds for the site to rebuild
5. Refresh your site to see changes
