const OWNER_COMPLETE_PATH = '/digital-checkin/owner-success';
const TENANT_COMPLETE_PATH = '/digital-checkin/tenant-confirmation';

function getFrontendBaseUrl() {
    return (
        process.env.DIGITAL_CHECKIN_URL ||
        process.env.ADMIN_URL ||
        process.env.FRONTEND_URL ||
        process.env.APP_URL ||
        'https://roomhy.com'
    );
}

function getBearerHeaders() {
    const accessToken = process.env.ZOHO_SIGN_ACCESS_TOKEN || '';
    if (!accessToken) return {};
    if (/^(Bearer|Zoho-oauthtoken)\s/i.test(accessToken)) {
        return { Authorization: accessToken };
    }
    return { Authorization: `Zoho-oauthtoken ${accessToken}` };
}

function buildCompleteUrl(pathname, loginId, extraParams = {}) {
    const base = new URL(getFrontendBaseUrl());
    base.pathname = pathname;
    base.searchParams.set('loginId', String(loginId || '').toUpperCase());
    Object.entries(extraParams).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            base.searchParams.set(key, String(value));
        }
    });
    return base.toString();
}

function getOwnerCompleteUrl(loginId) {
    return buildCompleteUrl(OWNER_COMPLETE_PATH, loginId, { completeAgreement: '1' });
}

function getTenantCompleteUrl(loginId) {
    return buildCompleteUrl(TENANT_COMPLETE_PATH, loginId, { completeAgreement: '1' });
}

function isZohoConfigured() {
    return Boolean(process.env.ZOHO_SIGN_CREATE_URL && process.env.ZOHO_SIGN_ACCESS_TOKEN);
}

function getTemplateValue(kind) {
    if (kind === 'tenant') {
        return process.env.ZOHO_SIGN_TENANT_TEMPLATE_ID || process.env.ZOHO_SIGN_TEMPLATE_ID || '';
    }
    if (kind === 'owner') {
        return process.env.ZOHO_SIGN_OWNER_TEMPLATE_ID || process.env.ZOHO_SIGN_TEMPLATE_ID || '';
    }
    return process.env.ZOHO_SIGN_TEMPLATE_ID || '';
}

function getActionId(kind) {
    if (kind === 'tenant') {
        return process.env.ZOHO_SIGN_TENANT_ACTION_ID || process.env.ZOHO_SIGN_ACTION_ID || '';
    }
    if (kind === 'owner') {
        return process.env.ZOHO_SIGN_OWNER_ACTION_ID || process.env.ZOHO_SIGN_ACTION_ID || '';
    }
    return process.env.ZOHO_SIGN_ACTION_ID || '';
}

function getRole(kind) {
    if (kind === 'tenant') {
        return process.env.ZOHO_SIGN_TENANT_ROLE || process.env.ZOHO_SIGN_ROLE || '';
    }
    if (kind === 'owner') {
        return process.env.ZOHO_SIGN_OWNER_ROLE || process.env.ZOHO_SIGN_ROLE || '';
    }
    return process.env.ZOHO_SIGN_ROLE || '';
}

function getZohoEndpoint(templateValue) {
    const raw = String(templateValue || '').trim();
    if (/^https?:\/\//i.test(raw)) return raw;
    return process.env.ZOHO_SIGN_CREATE_URL;
}

function toZohoTemplateRequestData(payload) {
    const signer = payload.tenant || payload.owner || {};
    const actionId = String(payload.actionId || '').trim();
    const role = String(payload.role || '').trim();
    return {
        templates: {
            request_name: payload.documentName,
            actions: [
                {
                    ...(actionId ? { action_id: actionId } : {}),
                    action_type: 'SIGN',
                    signing_order: 1,
                    verify_recipient: false,
                    ...(role ? { role } : {}),
                    recipient_name: signer.name || signer.eSignName || 'Signer',
                    recipient_email: signer.email || '',
                    recipient_phonenumber: signer.phone || '',
                    private_notes: 'Please review and sign the RoomHy agreement.'
                }
            ],
            field_data: {
                field_text_data: payload.fields || {}
            },
            notes: 'RoomHy agreement'
        }
    };
}

function pickFirstString(values = []) {
    return values.find((value) => typeof value === 'string' && value.trim()) || '';
}

function buildOwnerAgreementPayload({ owner = {}, loginId, aadhaarNumber, callbackUrl }) {
    const normalizedLoginId = String(loginId || '').toUpperCase();
    return {
        templateId: getTemplateValue('owner'),
        actionId: getActionId('owner'),
        role: getRole('owner'),
        documentName: `RoomHy Owner Agreement - ${normalizedLoginId}`,
        callbackUrl,
        redirectUrl: getOwnerCompleteUrl(normalizedLoginId),
        owner: {
            loginId: normalizedLoginId,
            name: owner.name || owner.profile?.name || '',
            email: owner.email || owner.profile?.email || '',
            phone: owner.checkinPhone || owner.phone || owner.profile?.phone || '',
            area: owner.checkinArea || owner.area || owner.locationCode || owner.profile?.locationCode || '',
            aadhaarNumber: aadhaarNumber || owner.checkinAadhaarNumber || owner.kyc?.aadharNumber || ''
        },
        fields: {
            owner_name: owner.name || owner.profile?.name || '',
            owner_email: owner.email || owner.profile?.email || '',
            owner_phone: owner.checkinPhone || owner.phone || owner.profile?.phone || '',
            owner_login_id: normalizedLoginId,
            owner_area: owner.checkinArea || owner.area || owner.locationCode || owner.profile?.locationCode || '',
            owner_aadhaar_number: aadhaarNumber || owner.checkinAadhaarNumber || owner.kyc?.aadharNumber || ''
        }
    };
}

function buildTenantAgreementPayload({ tenant = {}, loginId, eSignName, callbackUrl }) {
    const normalizedLoginId = String(loginId || '').toUpperCase();
    const tenantName = tenant.name || tenant.digitalCheckin?.profile?.name || '';
    const tenantEmail = tenant.email || tenant.digitalCheckin?.profile?.email || '';
    const propertyName = tenant.propertyTitle || tenant.digitalCheckin?.profile?.propertyName || '';
    const roomNo = tenant.roomNo || tenant.digitalCheckin?.profile?.roomNo || '';
    const agreedRent = tenant.agreedRent || tenant.digitalCheckin?.profile?.agreedRent || '';
    const moveInDate = tenant.moveInDate
        ? new Date(tenant.moveInDate).toISOString().slice(0, 10)
        : (tenant.digitalCheckin?.profile?.moveInDate || '');

    return {
        templateId: getTemplateValue('tenant'),
        actionId: getActionId('tenant'),
        role: getRole('tenant'),
        documentName: `RoomHy Tenant Rental Agreement - ${normalizedLoginId}`,
        callbackUrl,
        redirectUrl: getTenantCompleteUrl(normalizedLoginId),
        tenant: {
            loginId: normalizedLoginId,
            name: tenantName,
            email: tenantEmail,
            phone: tenant.phone || '',
            propertyName,
            roomNo,
            agreedRent,
            moveInDate,
            eSignName: eSignName || tenantName
        },
        fields: {
            tenant_name: tenantName,
            tenant_email: tenantEmail,
            tenant_phone: tenant.phone || '',
            tenant_login_id: normalizedLoginId,
            property_name: propertyName,
            room_no: roomNo,
            agreed_rent: agreedRent,
            move_in_date: moveInDate,
            tenant_esign_name: eSignName || tenantName
        }
    };
}

async function createZohoRequest({ payload, loginId, providerLabel, completeUrl }) {
    const normalizedLoginId = String(loginId || '').toUpperCase();

    if (!isZohoConfigured()) {
        const requestId = `MOCK-ZOHO-${normalizedLoginId}-${Date.now()}`;
        return {
            provider: `mock-${providerLabel}`,
            requestId,
            status: 'pending_signature',
            signUrl: completeUrl(normalizedLoginId),
            payload,
            raw: { mock: true }
        };
    }

    const endpoint = getZohoEndpoint(payload.templateId);
    const isTemplateEndpoint = /\/templates\/.+\/createdocument/i.test(String(endpoint || ''));
    if (isTemplateEndpoint && !String(payload.actionId || '').trim()) {
        const error = new Error('Zoho template action id is missing');
        error.status = 400;
        error.data = {
            message: 'Zoho template action id is missing. Set ZOHO_SIGN_TENANT_ACTION_ID or ZOHO_SIGN_ACTION_ID in backend environment.'
        };
        throw error;
    }
    const requestOptions = isTemplateEndpoint
        ? (() => {
            const formData = new FormData();
            formData.set('data', JSON.stringify(toZohoTemplateRequestData(payload)));
            formData.set('is_quicksend', 'true');
            return {
                method: 'POST',
                headers: {
                    ...getBearerHeaders()
                },
                body: formData
            };
        })()
        : {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...getBearerHeaders()
            },
            body: JSON.stringify(payload)
        };

    const response = await fetch(endpoint, requestOptions);

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(
            data?.message ||
            data?.error ||
            `Zoho Sign request failed (${response.status})`
        );
        error.status = response.status;
        error.data = data;
        throw error;
    }

    const signUrl = pickFirstString([
        data?.signUrl,
        data?.sign_url,
        data?.signing_url,
        data?.request?.sign_url,
        data?.request?.signUrl,
        data?.document?.sign_url,
        data?.document?.signUrl,
        data?.requests?.[0]?.sign_url,
        data?.requests?.[0]?.signUrl
    ]);
    const requestId = pickFirstString([
        data?.requestId,
        data?.request_id,
        data?.document_id,
        data?.documentId,
        data?.requests?.[0]?.request_id,
        data?.requests?.[0]?.requestId
    ]) || `ZOHO-${normalizedLoginId}-${Date.now()}`;

    return {
        provider: providerLabel,
        requestId,
        status: 'pending_signature',
        signUrl: signUrl || completeUrl(normalizedLoginId),
        payload,
        raw: data
    };
}

async function createOwnerAgreementRequest({ owner = {}, loginId, aadhaarNumber, callbackUrl }) {
    const normalizedLoginId = String(loginId || '').toUpperCase();
    const payload = buildOwnerAgreementPayload({ owner, loginId: normalizedLoginId, aadhaarNumber, callbackUrl });
    return createZohoRequest({
        payload,
        loginId: normalizedLoginId,
        providerLabel: 'zoho-sign',
        completeUrl: getOwnerCompleteUrl
    });
}

async function createTenantAgreementRequest({ tenant = {}, loginId, eSignName, callbackUrl }) {
    const normalizedLoginId = String(loginId || '').toUpperCase();
    const payload = buildTenantAgreementPayload({ tenant, loginId: normalizedLoginId, eSignName, callbackUrl });
    return createZohoRequest({
        payload,
        loginId: normalizedLoginId,
        providerLabel: 'zoho-sign',
        completeUrl: getTenantCompleteUrl
    });
}

module.exports = {
    buildOwnerAgreementPayload,
    buildTenantAgreementPayload,
    createOwnerAgreementRequest,
    createTenantAgreementRequest,
    getOwnerCompleteUrl,
    getTenantCompleteUrl
};
