// Verhoeff checksum tables — UIDAI standard for all 12-digit Aadhaar numbers
const _VD = [
    [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
    [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
    [9,8,7,6,5,4,3,2,1,0]
];
const _VP = [
    [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
    [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]
];

function verhoeffCheck(number) {
    const digits = String(number).replace(/\D/g, '').split('').reverse().map(Number);
    if (digits.length !== 12) return false;
    let c = 0;
    for (let i = 0; i < digits.length; i++) c = _VD[c][_VP[i % 8][digits[i]]];
    return c === 0;
}

// Recursively extracts a 12-digit Aadhaar number from nested OCR response objects/arrays
function extractAadhaarNumber(value) {
    if (!value) return '';
    if (typeof value === 'string') {
        const digits = value.replace(/\D/g, '');
        return digits.length === 12 ? digits : '';
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const extracted = extractAadhaarNumber(item);
            if (extracted) return extracted;
        }
        return '';
    }
    if (typeof value === 'object') {
        const priorityKeys = [
            'aadhaar_number', 'aadhaarNumber', 'aadhar_number', 'aadharNumber',
            'document_number', 'documentNumber', 'id_number', 'idNumber', 'uid', 'number', 'value'
        ];
        for (const key of priorityKeys) {
            const extracted = extractAadhaarNumber(value[key]);
            if (extracted) return extracted;
        }
        for (const nested of Object.values(value)) {
            const extracted = extractAadhaarNumber(nested);
            if (extracted) return extracted;
        }
    }
    return '';
}

module.exports = { verhoeffCheck, extractAadhaarNumber };
