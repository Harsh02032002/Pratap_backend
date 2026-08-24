const mongoose = require('mongoose');

const SeoPageSchema = new mongoose.Schema(
    {
        pageKey: { type: String, trim: true, index: true }, // Key for page (e.g. 'home', 'about', 'our-property')
        pageName: { type: String, required: true, trim: true },
        slug: { type: String, trim: true, index: true, unique: true, sparse: true }, // Clean route path match
        
        // Entity reference (e.g. Project, Locality, City, Area, Property, Blog)
        entityType: { type: String, trim: true, index: true, default: null },
        entityId: { type: String, trim: true, index: true, default: null },
        
        // Structured Location & Property Type Metadata for SEO Landing Pages
        city: { type: String, trim: true, default: '' },
        area: { type: String, trim: true, default: '' },
        propertyType: { type: String, trim: true, default: '' },
        
        // Core Metadata
        metaTitle: { type: String, trim: true, default: '' },
        metaDescription: { type: String, trim: true, default: '' },
        metaKeywords: { type: String, trim: true, default: '' },
        primaryKeyword: { type: String, trim: true, default: '' },
        secondaryKeywords: { type: [String], default: [] },
        
        // Advanced SEO
        canonicalUrl: { type: String, trim: true, default: '' },
        robots: { type: String, trim: true, default: 'index, follow' },
        h1: { type: String, trim: true, default: '' },
        seoContent: { type: String, default: '' },
        jsonLdSchema: { type: String, default: '' }, // Stringified JSON-LD or structured schema representation
        
        // Open Graph
        openGraphTitle: { type: String, trim: true, default: '' },
        openGraphDescription: { type: String, trim: true, default: '' },
        openGraphImage: { type: String, trim: true, default: '' },
        openGraphType: { type: String, trim: true, default: 'website' },
        openGraphUrl: { type: String, trim: true, default: '' },
        
        // Twitter Card
        twitterCard: { type: String, trim: true, default: 'summary_large_image' },
        twitterTitle: { type: String, trim: true, default: '' },
        twitterDescription: { type: String, trim: true, default: '' },
        twitterImage: { type: String, trim: true, default: '' },
        
        // Sitemap Controls
        isIndexed: { type: Boolean, default: true, index: true },
        robots: { type: String, trim: true, default: 'index, follow' },
        sitemapPriority: { type: Number, default: 0.5 },
        sitemapChangefreq: { type: String, default: 'weekly' }
    },
    { 
        timestamps: true 
    }
);

// Compound index to guarantee uniqueness of a page template or page associated with an entity.
SeoPageSchema.index({ pageKey: 1, entityId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('SeoPage', SeoPageSchema);
