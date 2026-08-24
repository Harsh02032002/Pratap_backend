import json
import os
import re

json_path = r'd:/hello-roomhy/Roomhy-Backend/scratch/seo_sheet_data.json'
js_output_path = r'd:/hello-roomhy/Roomhy-Backend/scripts/seoSheetData.json'

with open(json_path, 'r', encoding='utf-8') as f:
    raw_data = json.load(f)

sheet_rows = raw_data.get('xl/worksheets/sheet1.xml', [])

header = sheet_rows[0]
rows = sheet_rows[1:]

seo_items = []
seen_slugs = set()

for idx, r in enumerate(rows):
    if not r or len(r) < 5:
        continue
    page_type = r[0].strip() if len(r) > 0 else ''
    url_path = r[1].strip() if len(r) > 1 else ''
    primary_kw = r[2].strip() if len(r) > 2 else ''
    sec_kw_1 = r[3].strip() if len(r) > 3 else ''
    sec_kw_2 = r[4].strip() if len(r) > 4 else ''
    sec_kw_3 = r[5].strip() if len(r) > 5 else ''
    sec_kw_4 = r[6].strip() if len(r) > 6 else ''
    sec_kw_5 = r[7].strip() if len(r) > 7 else ''
    intent = r[8].strip() if len(r) > 8 else ''
    h1 = r[9].strip() if len(r) > 9 else ''
    title = r[10].strip() if len(r) > 10 else ''
    desc = r[11].strip() if len(r) > 11 else ''

    if not url_path:
        continue

    clean_slug = url_path.strip().lstrip('/')
    
    if clean_slug in seen_slugs:
        continue
    seen_slugs.add(clean_slug)

    sec_kws = [k for k in [sec_kw_1, sec_kw_2, sec_kw_3, sec_kw_4, sec_kw_5] if k]
    all_kws = [primary_kw] + sec_kws if primary_kw else sec_kws

    is_indexed = True
    robots = "index, follow"
    if clean_slug in ['login', 'register', 'owner-dashboard', 'tenant-dashboard']:
        is_indexed = False
        robots = "noindex, nofollow"

    canonical = f"https://roomhy.com/{clean_slug}".rstrip('/')
    if clean_slug == '':
        canonical = "https://roomhy.com"

    seo_items.append({
        "slug": clean_slug,
        "pageType": page_type,
        "pageKey": f"sheet-{clean_slug or 'home'}",
        "h1": h1 or primary_kw or "Roomhy Accommodation",
        "metaTitle": title or f"{h1 or 'Roomhy'} | Roomhy",
        "metaDescription": desc or f"Find verified student housing and rental properties on Roomhy.",
        "primaryKeyword": primary_kw,
        "secondaryKeywords": sec_kws,
        "metaKeywords": ", ".join(all_kws),
        "canonicalUrl": canonical,
        "robots": robots,
        "isIndexed": is_indexed
    })

with open(js_output_path, 'w', encoding='utf-8') as f:
    json.dump(seo_items, f, ensure_ascii=False, indent=2)

print(f"Parsed {len(seo_items)} unique SEO sheet entries into {js_output_path}")
