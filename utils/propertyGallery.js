'use strict';

function flattenListingImages(source = {}) {
    const fromImages = Array.isArray(source.images) ? source.images : [];
    const fromViews = (source.propertyViews || []).flatMap((view) => view.images || []);
    const fromListing = Array.isArray(source.listingImages) ? source.listingImages : [];
    const fromInfo = Array.isArray(source.propertyInfo?.photos) ? source.propertyInfo.photos : [];
    return [...new Set([...fromImages, ...fromViews, ...fromListing, ...fromInfo].filter(Boolean))];
}

function pickListingViews(source = {}, fallback = []) {
    const views = Array.isArray(source.propertyViews) ? source.propertyViews.filter((v) => v && (v.label || (v.images || []).length)) : [];
    if (views.some((v) => (v.images || []).length)) return views;
    if (Array.isArray(fallback) && fallback.some((v) => (v.images || []).length)) return fallback;
    return views.length ? views : fallback;
}

module.exports = {
    flattenListingImages,
    pickListingViews
};
