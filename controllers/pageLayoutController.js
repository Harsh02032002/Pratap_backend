const PageLayout = require('../models/PageLayout');

// Default layout configurations with nested lists/cards for full content control
const defaultLayouts = {
  home: {
    pageName: 'Home Page',
    sections: [
      {
        id: 'hero',
        name: 'Hero Slider Section',
        type: 'hero',
        visible: true,
        order: 0,
        content: {
          title: 'Premium Broker-Free Student & Professional Living',
          subtitle: 'Find and book premium PGs, Hostels, and Co-living spaces in major hubs.',
          buttonText: 'Explore Rooms',
          image1: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?q=80&w=1980&auto=format&fit=crop',
          image2: 'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?q=80&w=2070&auto=format&fit=crop',
          image3: 'https://images.unsplash.com/photo-1494203484021-3c454daf695d?q=80&w=2070&auto=format&fit=crop'
        }
      },
      {
        id: 'offerings',
        name: 'What We Offer',
        type: 'offerings',
        visible: true,
        order: 1,
        content: {
          title: 'What We Offer',
          subtitle: 'Choose from a variety of accommodation types tailored for students',
          list: [
            { title: 'PG', category: 'PG', description: 'Comfortable paying guest accommodations with all amenities', image: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?q=80&w=600&auto=format&fit=crop' },
            { title: 'Hostel', category: 'Hostel', description: 'Affordable hostel living for students and working professionals', image: 'https://images.unsplash.com/photo-1555854877-bab0e564b8d5?q=80&w=600&auto=format&fit=crop' },
            { title: 'Co-living', category: 'Co-living', description: 'Modern co-living spaces with community and facilities', image: 'https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?q=80&w=600&auto=format&fit=crop' },
            { title: 'Apartment/Flats', category: 'Apartment', description: 'Private apartments for individuals and small groups', image: 'https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?q=80&w=600&auto=format&fit=crop' },
            { title: 'List Property', category: 'List', description: 'Are you an owner? List your property on Roomhy for free!', image: 'https://images.unsplash.com/photo-1560518883-ce09059eeffa?q=80&w=600&auto=format&fit=crop' }
          ]
        }
      },
      {
        id: 'cities',
        name: 'Popular Cities',
        type: 'cities',
        visible: true,
        order: 2,
        content: {
          title: 'Find Rooms in Popular Cities',
          subtitle: 'Explore student housings and rooms near major universities.'
        }
      },
      {
        id: 'properties',
        name: 'Trending Properties',
        type: 'properties',
        visible: true,
        order: 3,
        content: {
          title: 'Trending Stays This Week',
          subtitle: 'Most popular properties among students'
        }
      },
      {
        id: 'recently-viewed',
        name: 'Recently Viewed',
        type: 'recently-viewed',
        visible: true,
        order: 4,
        content: {
          title: 'Recently Viewed',
          subtitle: 'Pick up where you left off'
        }
      },
      {
        id: 'why-choose-us',
        name: 'Why Choose Roomhy',
        type: 'why-choose-us',
        visible: true,
        order: 5,
        content: {
          title: 'Why Choose Roomhy?',
          subtitle: "Built by students, for students. Here's why thousands trust us.",
          list: [
            { title: "Zero Brokerage Always", description: "Tired of paying brokers just to see a room? With Roomhy, you connect directly with verified property owners. No middlemen, no extra charges.", image: "https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?auto=format&fit=crop&w=800&q=80" },
            { title: "Only Pay What You Bid", description: "No fixed pricing. No pressure. Set your own budget and place a live bid - the owner picks the best offer.", image: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=800&q=80" },
            { title: "Verified Properties Only", description: "Every listing is verified by our team. No fake photos, no hidden charges. What you see is what you get.", image: "https://images.unsplash.com/photo-1560518883-ce09059eeffa?auto=format&fit=crop&w=800&q=80" },
            { title: "Fully Furnished", description: "Move in with just your suitcase. Our properties come with all the essential furniture and amenities.", image: "https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?auto=format&fit=crop&w=800&q=80" },
            { title: "24/7 Support", description: "From booking to move-out, our dedicated support team is always here to help you with any queries.", image: "https://images.unsplash.com/photo-1582213782179-e0d53f98f2ca?auto=format&fit=crop&w=800&q=80" },
            { title: "Flexible Booking", description: "Book for any duration - short term or long term. Cancel anytime with refund.", image: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=800&q=80" }
          ]
        }
      },
      {
        id: 'testimonials',
        name: 'Testimonials / Reviews',
        type: 'testimonials',
        visible: true,
        order: 6,
        content: {
          title: 'What Students Say',
          subtitle: 'Trusted by 10,000+ students across India',
          list: [
            { name: "Rahul Sharma", role: "IIT Delhi Student", text: "Roomhy made finding my hostel so easy! Zero brokerage and the bidding feature helped me get a great deal.", avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=face", rating: "5" },
            { name: "Priya Patel", role: "Medical Student", text: "The 24/7 support team helped me find a safe PG near my college. Best platform for students!", avatar: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&h=100&fit=crop&crop=face", rating: "5" },
            { name: "Vikram Singh", role: "Working Professional", text: "The ₹500 booking token is such a smart feature. It shows owners you're serious about renting.", avatar: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100&h=100&fit=crop&crop=face", rating: "5" },
            { name: "Anjali Mehta", role: "CA Student", text: "Moved to Kota for coaching and found the perfect hostel within a day. Thank you Roomhy!", avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=face", rating: "5" }
          ]
        }
      },
      {
        id: 'faq',
        name: 'How Roomhy Works',
        type: 'faq',
        visible: true,
        order: 7,
        content: {
          title: 'How Roomhy Works',
          subtitle: 'Find, compare, and book your perfect stay in just a few steps',
          videoUrl: 'https://www.youtube.com/embed/4pFUP0HZwWM'
        }
      }
    ]
  },
  about: {
    pageName: 'About Page',
    sections: [
      {
        id: 'about-hero',
        name: 'About Hero',
        type: 'about-hero',
        visible: true,
        order: 0,
        content: {
          title: 'About Us',
          subtitle: 'Our Story & Mission'
        }
      },
      {
        id: 'vision',
        name: 'Our Vision',
        type: 'vision',
        visible: true,
        order: 1,
        content: {
          title: 'Our Vision',
          list: [
            { title: 'Disrupt Traditional Model', description: 'Giving students the power to bid, book, and live without brokers, hidden charges, or negotiation stress.', image: 'https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?auto=format&fit=crop&w=600&q=80' },
            { title: 'Digital Transformation', description: 'Pioneering a new way for India\'s youth to find accommodation — transparent, real-time, and entirely online.', image: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=600&q=80' },
            { title: 'Student Empowerment', description: 'Founded in 2024, Roomhy is building the future of student housing in India.', image: 'https://images.unsplash.com/photo-1560518883-ce09059eeffa?auto=format&fit=crop&w=600&q=80' }
          ]
        }
      },
      {
        id: 'mission',
        name: 'Our Mission',
        type: 'mission',
        visible: true,
        order: 2,
        content: {
          title: 'Our Mission',
          list: [
            { title: 'Direct Connection', description: 'Enabling direct, real-time bidding between students and property owners.', image: 'https://images.unsplash.com/photo-1582213782179-e0d53f98f2ca?auto=format&fit=crop&w=600&q=80' },
            { title: 'Fair & Flexible', description: 'Making room rentals fair, flexible, and broker-free for everyone.', image: 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=600&q=80' },
            { title: 'Student-Centric', description: 'India\'s first student-centric property bidding platform helping students take control.', image: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=600&q=80' }
          ]
        }
      },
      {
        id: 'values',
        name: 'Our Values',
        type: 'values',
        visible: true,
        order: 3,
        content: {
          title: 'Our Values',
          list: [
            { title: 'Transparency', description: 'No middlemen. No hidden fees.' },
            { title: 'Empowerment', description: 'Students and owners are in full control.' },
            { title: 'Speed & Simplicity', description: 'From listing to booking in under 5 mins.' },
            { title: 'Trust', description: 'Every listing is verified. Every user is real.' }
          ]
        }
      },
      {
        id: 'stats',
        name: 'Operational Stats',
        type: 'stats',
        visible: true,
        order: 4,
        content: {
          cities: '5+',
          residences: '75+',
          beds: '5000+',
          students: '25K+'
        }
      },
      {
        id: 'team',
        name: 'Leadership Team',
        type: 'team',
        visible: true,
        order: 5,
        content: {
          title: 'Our Leadership',
          subtitle: 'The Minds Behind Roomhy',
          name: 'Resham Singh',
          role: 'Founder & Director',
          image: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=400',
          description: 'With a vision to transform India\'s student housing sector into a transparent, tech-driven ecosystem, ensuring broker-free, affordable accommodation for India\'s youth.'
        }
      }
    ]
  },
  contact: {
    pageName: 'Contact Page',
    sections: [
      {
        id: 'contact-hero',
        name: 'Contact Hero',
        type: 'contact-hero',
        visible: true,
        order: 0,
        content: {
          title: 'Get in Touch',
          subtitle: 'Reach out to the Roomhy team for any inquiries.'
        }
      },
      {
        id: 'contact-cards',
        name: 'Contact Cards',
        type: 'contact-cards',
        visible: true,
        order: 1,
        content: {
          email: 'team@roomhy.com',
          phone: '+91 99830 05030',
          address: '22, Krishna Nagar, Rangbari Road, Kota, Rajasthan - 324005'
        }
      },
      {
        id: 'contact-form',
        name: 'Enquiry Form',
        type: 'contact-form',
        visible: true,
        order: 2,
        content: {
          title: 'Send Us a Message',
          subtitle: 'We usually respond within 24 hours.'
        }
      }
    ]
  },
  'list-property': {
    pageName: 'List Property Page',
    sections: [
      {
        id: 'list-hero',
        name: 'List Property Hero',
        type: 'list-hero',
        visible: true,
        order: 0,
        content: {
          title: 'List Your Property on Roomhy',
          subtitle: 'Reach thousands of verified students and professionals with zero brokerage.'
        }
      },
      {
        id: 'owner-benefits',
        name: 'Owner Benefits',
        type: 'owner-benefits',
        visible: true,
        order: 1,
        content: {
          title: 'Why List with Us',
          subtitle: 'Direct bidding, direct tenant contact, and instant booking token payouts.'
        }
      }
    ]
  },
  faq: {
    pageName: 'FAQ Page',
    sections: [
      {
        id: 'faq-hero',
        name: 'FAQ Hero',
        type: 'faq-hero',
        visible: true,
        order: 0,
        content: {
          title: 'Frequently Asked Questions',
          subtitle: 'Find answers to common questions about bidding, booking, and hosting.'
        }
      },
      {
        id: 'faq-list',
        name: 'General FAQs',
        type: 'faq-list',
        visible: true,
        order: 1,
        content: {
          title: 'Common Questions'
        }
      }
    ]
  },
  privacy: {
    pageName: 'Privacy Policy Page',
    sections: [
      {
        id: 'privacy-hero',
        name: 'Privacy Hero',
        type: 'privacy-hero',
        visible: true,
        order: 0,
        content: {
          title: 'Privacy Policy',
          subtitle: 'Last updated: July 2026'
        }
      },
      {
        id: 'privacy-content',
        name: 'Policy Content',
        type: 'privacy-content',
        visible: true,
        order: 1,
        content: {
          introduction: 'We value your privacy and security. This policy outlines how we collect and use your data.'
        }
      }
    ]
  },
  terms: {
    pageName: 'Terms & Conditions Page',
    sections: [
      {
        id: 'terms-hero',
        name: 'Terms Hero',
        type: 'terms-hero',
        visible: true,
        order: 0,
        content: {
          title: 'Terms & Conditions',
          subtitle: 'Last updated: July 2026'
        }
      },
      {
        id: 'terms-content',
        name: 'Terms Content',
        type: 'terms-content',
        visible: true,
        order: 1,
        content: {
          clause: 'By using the Roomhy portal, you agree to comply with our terms and guidelines.'
        }
      }
    ]
  },
  login: {
    pageName: 'Login Page',
    sections: [
      {
        id: 'login-hero',
        name: 'Login Welcome Banner',
        type: 'login-hero',
        visible: true,
        order: 0,
        content: {
          title: 'Welcome Back',
          subtitle: 'Log in to continue managing and booking your stays.'
        }
      }
    ]
  },
  register: {
    pageName: 'Signup Page',
    sections: [
      {
        id: 'register-hero',
        name: 'Signup Welcome Banner',
        type: 'register-hero',
        visible: true,
        order: 0,
        content: {
          title: 'Join Roomhy Today',
          subtitle: 'Create a free account to start bidding on verified student housings.'
        }
      }
    ]
  },
  'our-property': {
    pageName: 'Property Listing Page',
    sections: [
      {
        id: 'our-property-hero',
        name: 'Listing Header Banner',
        type: 'hero',
        visible: true,
        order: 0,
        content: {
          title: 'Our Properties',
          titleAccent: 'Properties',
          subtitle: 'Find PGs, Hostels, and Co-living spaces directly without brokers.'
        }
      },
      {
        id: 'our-property-filters',
        name: 'Filter Panel Labels',
        type: 'filters',
        visible: true,
        order: 1,
        content: {
          cityLabel: 'City',
          areaLabel: 'Area / Locality',
          typeLabel: 'Property Type',
          genderLabel: 'Gender',
          priceLabel: 'Price Range',
          searchPlaceholder: 'Search by name, area, city...',
          filterButtonText: 'Apply Filters',
          clearButtonText: 'Clear All'
        }
      },
      {
        id: 'our-property-card',
        name: 'Property Card Labels',
        type: 'card',
        visible: true,
        order: 2,
        content: {
          verifiedBadge: 'Verified',
          viewDetailsButton: 'View Details',
          bidNowButton: 'Bid Now',
          perMonthLabel: '/month',
          bedsLabel: 'Beds',
          ratingLabel: 'Rating'
        }
      },
      {
        id: 'our-property-empty',
        name: 'Empty State Message',
        type: 'empty',
        visible: true,
        order: 3,
        content: {
          title: 'No Properties Found',
          subtitle: 'Try adjusting your filters or search for a different location.',
          resetButtonText: 'Reset Filters'
        }
      },
      {
        id: 'our-property-cta',
        name: 'Bottom CTA Banner',
        type: 'cta',
        visible: true,
        order: 4,
        content: {
          title: 'Own a Property?',
          subtitle: 'List your PG, Hostel or Co-living space on Roomhy for free. Get verified student inquiries directly.',
          buttonText: 'List Your Property',
          buttonLink: '/website/list'
        }
      }
    ]
  },
  'property-details': {
    pageName: 'Property Details Page',
    sections: [
      {
        id: 'property-details-header',
        name: 'Page Header Info',
        type: 'header',
        visible: true,
        order: 0,
        content: {
          breadcrumbHome: 'Home',
          breadcrumbProperties: 'Properties',
          breadcrumbDetails: '{propertyName}',
          shareButtonText: 'Share',
          saveButtonText: 'Save'
        }
      },
      {
        id: 'property-details-info',
        name: 'Booking CTA Callout',
        type: 'callout',
        visible: true,
        order: 1,
        content: {
          title: 'Direct Broker-Free Booking',
          subtitle: 'Reserve your bed now for a token amount of just ₹500. Fully refundable!',
          bookNowButton: 'Book Now',
          bidButton: 'Place a Bid',
          tokenAmount: '₹500'
        }
      },
      {
        id: 'property-details-highlights',
        name: 'Highlights Section',
        type: 'highlights',
        visible: true,
        order: 2,
        content: {
          title: 'Property Highlights',
          genderLabel: 'Gender',
          typeLabel: 'Property Type',
          priceLabel: 'Starting From',
          bedsLabel: 'Total Beds',
          locationLabel: 'Location'
        }
      },
      {
        id: 'property-details-amenities',
        name: 'Amenities Section',
        type: 'amenities',
        visible: true,
        order: 3,
        content: {
          title: 'Amenities & Facilities',
          subtitle: 'Everything you need for a comfortable stay',
          showAllButton: 'Show All Amenities',
          popularLabel: 'Popular',
          basicLabel: 'Basic Amenities'
        }
      },
      {
        id: 'property-details-rooms',
        name: 'Room Types Section',
        type: 'rooms',
        visible: true,
        order: 4,
        content: {
          title: 'Available Room Types',
          subtitle: 'Choose the room that fits your budget and preference',
          priceLabel: 'per month',
          selectButton: 'Select Room'
        }
      },
      {
        id: 'property-details-reviews',
        name: 'Reviews Section',
        type: 'reviews',
        visible: true,
        order: 5,
        content: {
          title: 'Guest Reviews',
          subtitle: 'What students say about this property',
          writeReviewButton: 'Write a Review',
          noReviewsText: 'No reviews yet. Be the first to review!'
        }
      },
      {
        id: 'property-details-nearby',
        name: 'Nearby Institutions',
        type: 'nearby',
        visible: true,
        order: 6,
        content: {
          title: 'Nearby Colleges & Universities',
          subtitle: 'Educational institutions within 2.5 km radius',
          distanceLabel: 'km away',
          noInstitutionsText: 'No institutions found nearby'
        }
      },
      {
        id: 'property-details-contact',
        name: 'Contact Owner Section',
        type: 'contact',
        visible: true,
        order: 7,
        content: {
          title: 'Contact Property Owner',
          subtitle: 'Get in touch directly — no brokers, no middlemen',
          callButton: 'Call Owner',
          chatButton: 'Chat on WhatsApp',
          emailButton: 'Send Email'
        }
      }
    ]
  }
};

exports.getPageLayout = async (req, res) => {
  try {
    const { pageKey } = req.params;

    let layout = await PageLayout.findOne({ pageKey });
    const defaultLayout = defaultLayouts[pageKey];

    if (!layout) {
      if (!defaultLayout) {
        return res.status(404).json({
          success: false,
          message: `Layout not defined for page: ${pageKey}`
        });
      }

      layout = new PageLayout({
        pageKey,
        sections: defaultLayout.sections,
        updatedBy: 'system'
      });

      await layout.save();
    } else if (defaultLayout) {
      // Auto-heal/sync database layouts with code configuration defaults
      let modified = false;
      const dbSections = [...layout.sections];

      for (const defSec of defaultLayout.sections) {
        const dbSecIdx = dbSections.findIndex(s => s.id === defSec.id);
        if (dbSecIdx === -1) {
          // Append missing section
          dbSections.push(defSec);
          modified = true;
        } else {
          // Merge content keys
          const dbSec = dbSections[dbSecIdx];
          const mergedContent = { ...defSec.content, ...dbSec.content };
          if (JSON.stringify(mergedContent) !== JSON.stringify(dbSec.content)) {
            dbSec.content = mergedContent;
            modified = true;
          }
        }
      }

      if (modified) {
        layout.sections = dbSections.sort((a, b) => a.order - b.order);
        await PageLayout.updateOne({ pageKey }, { $set: { sections: layout.sections } });
      }
    }

    return res.status(200).json({
      success: true,
      data: layout
    });
  } catch (error) {
    console.error('Error fetching page layout:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve page layout',
      error: error.message
    });
  }
};

exports.updatePageLayout = async (req, res) => {
  try {
    const { pageKey } = req.params;
    const { sections } = req.body;

    if (!Array.isArray(sections)) {
      return res.status(400).json({
        success: false,
        message: 'sections array is required'
      });
    }

    const updated = await PageLayout.findOneAndUpdate(
      { pageKey },
      {
        $set: {
          sections,
          updatedBy: req.user?.email || 'superadmin'
        }
      },
      { new: true, upsert: true }
    );

    return res.status(200).json({
      success: true,
      message: 'Page layout updated successfully',
      data: updated
    });
  } catch (error) {
    console.error('Error updating page layout:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update page layout',
      error: error.message
    });
  }
};
