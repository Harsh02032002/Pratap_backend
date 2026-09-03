'use strict';

function flattenListingImages(source = {}) {
    const photoDetails = Array.isArray(source.photoDetails) ? source.photoDetails : [];
    
    // Live camera capture photo URLs to EXCLUDE from public website gallery
    const cameraUrls = new Set(
        photoDetails
            .filter((d) => d && (d.source === 'camera' || d.isLiveCapture || d.type === 'camera' || d.isCamera === true))
            .map((d) => d.url)
            .filter(Boolean)
    );

    // Also check propertyViews for "Live Camera" or "Camera" category
    (source.propertyViews || []).forEach((view) => {
        const label = String(view?.label || '').toLowerCase();
        if (label.includes('camera') || label.includes('live')) {
            (view.images || []).forEach((url) => { if (url) cameraUrls.add(url); });
        }
    });

    const isNotCamera = (url) => url && !cameraUrls.has(url);

    const fromImages = (Array.isArray(source.images) ? source.images : []).filter(isNotCamera);
    const fromViews = (source.propertyViews || [])
        .filter((view) => {
            const label = String(view?.label || '').toLowerCase();
            return !label.includes('camera') && !label.includes('live');
        })
        .flatMap((view) => view.images || [])
        .filter(isNotCamera);
    const fromListing = (Array.isArray(source.listingImages) ? source.listingImages : []).filter(isNotCamera);
    const fromInfo = (Array.isArray(source.propertyInfo?.photos) ? source.propertyInfo.photos : []).filter(isNotCamera);
    const fromPhotos = (Array.isArray(source.photos) ? source.photos : []).filter(isNotCamera);

    let allPublic = [...new Set([...fromImages, ...fromViews, ...fromListing, ...fromInfo, ...fromPhotos].filter(Boolean))];
    return allPublic;
}

function pickListingViews(source = {}, fallback = []) {
    const views = Array.isArray(source.propertyViews) ? source.propertyViews.filter((v) => {
        if (!v) return false;
        const label = String(v.label || '').toLowerCase();
        return !label.includes('camera') && !label.includes('live') && (v.label || (v.images || []).length);
    }) : [];
    if (views.some((v) => (v.images || []).length)) return views;
    if (Array.isArray(fallback) && fallback.some((v) => (v.images || []).length)) return fallback;
    return views.length ? views : fallback;
}

module.exports = {
    flattenListingImages,
    pickListingViews
};
