const { createWorker } = require('tesseract.js');

/**
 * Detect document type from uploaded image
 * @param {string} imageData - Base64 image data, file path, or URL
 * @returns {Promise<{type: 'aadhaar' | 'pan' | 'unknown', confidence: number}>}
 */
async function detectDocumentType(imageData) {
    let worker = null;
    try {
        if (!imageData) {
            return { type: 'unknown', confidence: 0 };
        }

        console.log('[DOCUMENT VALIDATION] Starting document type detection...');

        // Convert base64 data URL to Buffer if needed to save V8 string heap memory
        let imageBuffer = imageData;
        if (typeof imageData === 'string') {
            if (imageData.startsWith('data:image')) {
                const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
                imageBuffer = Buffer.from(base64Data, 'base64');
            } else if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
                imageBuffer = imageData;
            } else if (imageData.length > 500 && /^[A-Za-z0-9+/=]+$/.test(imageData.substring(0, 100))) {
                imageBuffer = Buffer.from(imageData, 'base64');
            }
        }

        // Limit maximum buffer size to 5MB to prevent Node V8 out-of-memory crashes
        if (Buffer.isBuffer(imageBuffer) && imageBuffer.length > 5 * 1024 * 1024) {
            console.warn('[DOCUMENT VALIDATION] Image buffer too large (>', Math.round(imageBuffer.length / 1024 / 1024), 'MB), skipping OCR to prevent OOM crash.');
            return { type: 'unknown', confidence: 0 };
        }

        // Create worker explicitly so we can terminate it and release WebAssembly RAM
        worker = await createWorker('eng');
        
        // Execute recognition with 10-second safety timeout
        const recognizePromise = worker.recognize(imageBuffer);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('OCR recognition timeout')), 10000)
        );

        const result = await Promise.race([recognizePromise, timeoutPromise]);
        const text = (result && result.data && result.data.text) ? result.data.text.toLowerCase() : '';
        console.log('[DOCUMENT VALIDATION] Extracted text preview:', text.substring(0, 150));
        
        // Check for Aadhaar card patterns (expanded with common variants, Hindi text, 12-digit number formats, and keywords)
        const aadhaarPatterns = [
            /aadhaar|aadhar|adhar|addhar|adharcard/i,
            /आधार/i,
            /unique identification/i,
            /uidai/i,
            /government of india|govt of india|govemment/i,
            /भारत सरकार/i,
            /[2-9]\d{3}[\s\-]?\d{4}[\s\-]?\d{4}/,
            /\b(dob|date\s*of\s*birth|yob|year\s*of\s*birth)\b/i,
            /\b(male|female|transgender|पुरुष|महिला)\b/i,
            /help@uidai\.gov\.in|1947/i,
            /\b(father|s\/o|d\/o|w\/o|enrolment|enrollment|mera aadhaar)\b/i
        ];
        
        // Check for PAN card patterns
        const panPatterns = [
            /[A-Z]{5}[0-9]{4}[A-Z]{1}/,
            /\bpan\b|permanent account number/i,
            /income tax/i,
            /आयकर/i,
            /govt of india|government of india/i,
            /tax department/i
        ];
        
        let aadhaarScore = 0;
        let panScore = 0;
        
        // Score Aadhaar patterns
        aadhaarPatterns.forEach(pattern => {
            if (pattern.test(text)) aadhaarScore++;
        });
        
        // Score PAN patterns
        panPatterns.forEach(pattern => {
            if (pattern.test(text)) panScore++;
        });
        
        // Determine document type based on scores
        if (aadhaarScore > panScore && aadhaarScore > 0) {
            console.log('[DOCUMENT VALIDATION] Detected: Aadhaar card (Score:', aadhaarScore, ')');
            return { type: 'aadhaar', confidence: Math.min(aadhaarScore * 20, 100) };
        } else if (panScore > aadhaarScore && panScore > 0) {
            console.log('[DOCUMENT VALIDATION] Detected: PAN card (Score:', panScore, ')');
            return { type: 'pan', confidence: Math.min(panScore * 20, 100) };
        } else {
            console.log('[DOCUMENT VALIDATION] Unable to determine document type (Aadhaar score:', aadhaarScore, ', PAN score:', panScore, ')');
            return { type: 'unknown', confidence: 0 };
        }
        
    } catch (error) {
        console.error('[DOCUMENT VALIDATION] Error or timeout during document detection:', error.message);
        return { type: 'unknown', confidence: 0 };
    } finally {
        if (worker) {
            try {
                await worker.terminate();
            } catch (termErr) {
                console.error('[DOCUMENT VALIDATION] Worker termination error:', termErr.message);
            }
        }
    }
}

/**
 * Validate if uploaded document matches selected type
 * @param {string} imageData - Base64 image data or file path
 * @param {string} selectedType - 'Aadhaar Card' or 'PAN Card'
 * @returns {Promise<{valid: boolean, detectedType: string, message: string, inconclusive?: boolean}>}
 */
async function validateDocumentType(imageData, selectedType) {
    const detection = await detectDocumentType(imageData);
    
    const normalizedSelectedType = selectedType.toLowerCase();
    const detectedType = detection.type;
    
    console.log('[DOCUMENT VALIDATION] Selected:', selectedType, 'Detected:', detectedType);
    
    if (detectedType === 'unknown') {
        console.log('[DOCUMENT VALIDATION] OCR inconclusive (unknown document type). Allowing document for manual KYC review.');
        return {
            valid: true,
            detectedType: 'unknown',
            inconclusive: true,
            message: 'Document uploaded successfully. (Passed to manual verification)'
        };
    }
    
    if (normalizedSelectedType.includes('aadhaar') && detectedType === 'pan') {
        return {
            valid: false,
            detectedType: 'pan',
            message: 'You selected Aadhaar Card but uploaded a PAN card. Please select PAN Card instead.'
        };
    }
    
    if (normalizedSelectedType.includes('pan') && detectedType === 'aadhaar') {
        return {
            valid: false,
            detectedType: 'aadhaar',
            message: 'You selected PAN Card but uploaded an Aadhaar card. Please select Aadhaar Card instead.'
        };
    }
    
    if (
        (normalizedSelectedType.includes('aadhaar') && detectedType === 'aadhaar') ||
        (normalizedSelectedType.includes('pan') && detectedType === 'pan')
    ) {
        return {
            valid: true,
            detectedType: detectedType,
            message: 'Document type matches selection.'
        };
    }
    
    return {
        valid: false,
        detectedType: detectedType,
        message: `Document type mismatch. Selected: ${selectedType}, Detected: ${detectedType}`
    };
}

module.exports = {
    detectDocumentType,
    validateDocumentType
};
