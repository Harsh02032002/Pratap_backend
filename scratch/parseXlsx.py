import zipfile
import xml.etree.ElementTree as ET
import json
import os

xlsx_path = r'd:/hello-roomhy/Roomhy_Website_Work.xlsx'
output_json_path = r'd:/hello-roomhy/Roomhy-Backend/scratch/seo_sheet_data.json'

def parse_xlsx(file_path):
    with zipfile.ZipFile(file_path, 'r') as z:
        # Load shared strings
        shared_strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            ss_tree = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for elem in ss_tree.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si'):
                text = "".join([t.text for t in elem.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t') if t.text])
                shared_strings.append(text)

        # Load worksheet 1
        sheet_files = [f for f in z.namelist() if f.startswith('xl/worksheets/sheet') and f.endswith('.xml')]
        sheets_data = {}
        
        for sheet_file in sheet_files:
            sheet_tree = ET.fromstring(z.read(sheet_file))
            rows = []
            for row in sheet_tree.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheetData/{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row'):
                row_cells = []
                for cell in row.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c'):
                    cell_type = cell.attrib.get('t')
                    val_elem = cell.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')
                    cell_val = ''
                    if val_elem is not None and val_elem.text:
                        val = val_elem.text
                        if cell_type == 's':
                            idx = int(val)
                            cell_val = shared_strings[idx] if idx < len(shared_strings) else val
                        else:
                            cell_val = val
                    else:
                        # Check inline strings
                        is_elem = cell.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}is/{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t')
                        if is_elem is not None and is_elem.text:
                            cell_val = is_elem.text
                    row_cells.append(cell_val)
                rows.append(row_cells)
            sheets_data[sheet_file] = rows
        return sheets_data

try:
    data = parse_xlsx(xlsx_path)
    os.makedirs(os.path.dirname(output_json_path), exist_ok=True)
    with open(output_json_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"SUCCESS: Extracted data from {xlsx_path} into {output_json_path}")
except Exception as e:
    print(f"ERROR: {e}")
