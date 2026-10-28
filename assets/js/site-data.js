/* Shared browser-side content store for the public site and admin dashboard. */
(function () {
  const KEY = 'aff_content_v1';
  const basePath = (() => {
    const suffix = '/assets/js/site-data.js';
    const current = document.currentScript && document.currentScript.src;
    if (current) {
      const p = new URL(current, location.href).pathname;
      if (p.endsWith(suffix)) return p.slice(0, p.length - suffix.length);
    }
    return '';
  })();
  const api = path => `${basePath}${path}`;
  const publicUrl = path => `${basePath}${path}`;
  const defaults = {
    whatsapp: '255699126144',
    whatsappContacts: [
      { label: 'Chairperson', number: '255699126144' },
      { label: 'Secretary', number: '255765889888' },
      { label: 'Developer', number: '255698741459' }
    ],
    heroImage: 'assets/uploads/hero-group.jpg',
    gallery: [
      ['assets/uploads/kids-wall.jpg', 'Morning Lessons', 'Dar es Salaam · 2024'],
      ['assets/uploads/group-wheelchair.jpg', 'Afternoon Play', 'Mwanza Home · 2024'],
      ['assets/uploads/clinic-visit.jpg', 'Health Screening', 'Annual medical outreach · 2024'],
      ['assets/uploads/hero-group.jpg', 'Community Day', 'Morogoro · Annual gathering'],
      ['assets/uploads/food-drive.jpg', 'Food Distribution', 'Dar es Salaam · Monthly drive'],
      ['assets/uploads/child-care.jpg', 'New Arrivals', 'Welcome day · Mbeya'],
      ['assets/uploads/baobab-tour.jpg', 'Together We Grow', 'Field trip · 2024']
    ],
    reviews: [
      ['Amina, 11', 'Dar es Salaam · Joined 2022', "When Amina arrived, she hadn't been to school in two years. Today she reads aloud to younger children in the home and wants to be a teacher.", 'assets/uploads/community-pair.jpg'],
      ['Baraka, 9', 'Mwanza · Joined 2021', 'Baraka arrived malnourished and afraid. After 18 months of consistent care, he scored top in his class — his caregiver cried when she heard the news.', 'assets/uploads/child-care.jpg'],
      ['Neema, 14', 'Arusha · Joined 2019', 'Neema is now preparing for secondary school. She speaks three languages and volunteers at the foundation on weekends, helping younger children settle in.', 'assets/uploads/woman-pink.jpg']
    ],
    leaders: [
      ['Wilson Gasper', 'Founder · CEO', 'Wilson founded Agape Family Foundation in 2022 with a vision to give every orphaned child in Tanzania a second chance at life. Under his leadership, the foundation has grown to support over 520 children across 8 regions.', 'assets/uploads/leader-wilson.jpg']
    ],
    adminProfile: { name: 'Administrator', image: '' },
    hero: { childrenCount: '520+', headline: 'Children Given a Second Chance', description: 'Providing education, healthcare, and daily support to orphaned children across Tanzania.' },
    programs: [
      ['Education', 'We enroll children in accredited schools, provide uniforms, books, and after-school tutoring — ensuring no child falls behind due to poverty.', '340+', 'children currently enrolled in school', 'assets/uploads/prayer-group.jpg'],
      ['Healthcare', 'Monthly medical check-ups, vaccinations, nutritional support, and mental health care — because a healthy child can truly learn and grow.', '1,200+', 'medical visits covered last year', 'assets/uploads/clinic-visit.jpg'],
      ['Community', 'We build family-like homes and connect children with caregivers, mentors, and community support systems that last a lifetime.', '6', 'community homes across Tanzania', 'assets/uploads/food-drive.jpg']
    ],
    seo: { homeTitle: 'Agape Family Foundation | 520+ Children Given a Second Chance', homeDescription: 'Agape Family Foundation provides education, healthcare, and daily support to orphaned children across Tanzania.', shareImage: 'assets/uploads/hero-group.jpg' },
    donation: { paymentUrl: '', history: [], lipaNamba: { mpesa: { number: '123456', name: 'Agape Family Foundation' }, tigopesa: { number: '', name: '' }, airtel: { number: '', name: '' }, halotel: { number: '', name: '' } } },
    blog: [
      { id: 'post-1', image: 'assets/uploads/wilson-studio.jpg', date: 'May 2025', title: 'New Scholarship Program Launched', excerpt: "We're excited to announce a new scholarship program supporting 50 students pursuing secondary education. This initiative will change lives...", body: "We're excited to announce a new scholarship program supporting 50 students pursuing secondary education. Thanks to generous donors, these students will receive full tuition, books, and mentorship for the next four years. This initiative reflects our belief that education is the strongest path out of poverty, and we are proud to walk alongside these students as they pursue their dreams." },
      { id: 'post-2', image: 'assets/uploads/clinic-visit.jpg', date: 'April 2025', title: 'Annual Healthcare Outreach Reaches 1,200 Children', excerpt: "Our medical team completed a comprehensive health screening reaching over 1,200 children across 8 regions. Here's what we found...", body: 'Our medical team completed a comprehensive health screening reaching over 1,200 children across 8 regions. The outreach included vaccinations, dental checks, nutrition assessments, and referrals for children needing specialist care. We are grateful to the volunteer doctors and nurses who made this possible.' },
      { id: 'post-3', image: 'assets/uploads/community-pair.jpg', date: 'March 2025', title: 'Meet Amina: A Story of Hope and Determination', excerpt: "Two years ago, Amina couldn't read. Today, she's reading to other children. This is her story...", body: "Two years ago, Amina couldn't read a single word. Today, she's reading to other children in her home every evening. Her caregiver says the transformation has been remarkable to watch, and Amina now dreams of becoming a teacher herself one day." },
      { id: 'post-4', image: 'assets/uploads/food-drive.jpg', date: 'February 2025', title: 'Monthly Food Drive Feeds 300 Families', excerpt: 'Thanks to our donors and volunteers, this month we distributed cooking oil, sembe, and other essentials to 300 families across Dar es Salaam.', body: 'Thanks to our donors and volunteers, this month we distributed cooking oil, sembe, and other essentials to 300 families across Dar es Salaam. Each family received enough supplies for two weeks. This monthly drive has become a lifeline for the community, and we are grateful to everyone who made it possible.' },
      { id: 'post-5', image: 'assets/uploads/group-wheelchair.jpg', date: 'January 2025', title: 'Inclusive Care for Children with Disabilities', excerpt: 'Agape Family Foundation provides wheelchairs, mobility aids, and specialized care for children with disabilities across Tanzania.', body: 'Agape Family Foundation provides wheelchairs, mobility aids, and specialized care for children with disabilities across Tanzania. Our team works with physiotherapists and community health workers to ensure every child receives the support they need to live with dignity and independence.' },
      { id: 'post-6', image: 'assets/uploads/baobab-tour.jpg', date: 'December 2024', title: 'Field Trip: Learning Beyond the Classroom', excerpt: 'Our children visited Tanzania\'s iconic baobab trees — a day of discovery, joy, and connection with their heritage.', body: 'Our children visited Tanzania\'s iconic baobab trees — a day of discovery, joy, and connection with their heritage. Field trips like this give our children the chance to explore, learn, and simply be kids. We are grateful to the guides and volunteers who made this unforgettable day possible.' }
    ],
    contact: {
      email: 'info@agapefamilyfoundation.org',
      whatsapp: '255699126144',
      phone: '+255 22 212 3456',
      office: 'Dar es Salaam, Tanzania',
      regionalOffices: '8 Regional Offices',
      availability: 'Mon-Fri, 9 AM - 5 PM EAT',
      intro: "Have questions? Want to partner with us? Ready to make a difference? We'd love to hear from you. Reach out using any of the methods below."
    },
    analytics: [],
    messages: []
  };
  const copy = v => JSON.parse(JSON.stringify(v));
  function normalizeContacts(raw) {
    if (Array.isArray(raw)) return raw.slice(0, 3).map(c => ({ label: c.label || '', number: c.number || '' }));
    if (raw && typeof raw === 'object') {
      const order = [['chairperson', 'Chairperson'], ['secretary', 'Secretary'], ['developer', 'Developer'], ['groupAdmin', 'Group Admin']];
      return order.filter(([key]) => raw[key]).slice(0, 3).map(([key, label]) => ({ label, number: raw[key] }));
    }
    return [];
  }
  let cache = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { return {}; } })();
  const persistCache = data => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (_) { } };
  window.AFF = {
    defaults,
    get() { return Object.assign(copy(defaults), cache); },
    save(data) { cache=data; persistCache(data); },
    api, publicUrl,
    async load(admin = false) { const response = await fetch(api(admin ? '/api/admin/content' : '/api/content'), {credentials:'same-origin'}); if (!response.ok) throw new Error('Unable to load saved content.'); cache=Object.assign(cache, await response.json()); persistCache(cache); apply(); return this.get(); },
    async saveRemote(data) { cache=data; persistCache(data); const response=await fetch(api('/api/admin/content'),{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); if (!response.ok) throw new Error('Your secure session has expired. Sign in again.'); },
    async sendMessage(message) { this.save(Object.assign(this.get(),{messages:[...(this.get().messages||[]),message]})); const response=await fetch(api('/api/messages'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)}); if (!response.ok) throw new Error('Could not send message.'); },
    track(type, page, label) { if (location.protocol === 'file:' || localStorage.getItem('aff_cookie_consent') === 'rejected') return; fetch(api('/api/analytics'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,page:page||location.pathname,label:label||''})}).catch(()=>{}); },
    escape(text) { const el = document.createElement('div'); el.textContent = text || ''; return el.innerHTML; },
    apiUrl(path) { return api(path); },
    normalizeContacts,
    language() { return localStorage.getItem('aff_language') || 'en'; },
    setLanguage(lang) { localStorage.setItem('aff_language', lang === 'sw' ? 'sw' : 'en'); document.documentElement.lang = this.language(); },
    imageFile(file, options = {}) { /* ...unchanged, see your original file... */ }
  };

  // ============================================================
  // GITHUB-BACKED UPDATES (no backend) — fetches data/updates.json
  // from the same repo this site is hosted in, merges it into cache,
  // and prunes expired entries so the popup engine never shows stale ones.
  // ============================================================
  async function loadUpdatesFromRepo() {
    try {
      const url = `${basePath}/data/updates.json?_=${Date.now()}`;
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) return;
      const data = await r.json();
      const now = Date.now();
      const live = (data.updates || []).filter(u => !u.expiresAt || new Date(u.expiresAt).getTime() > now);
      cache = Object.assign(cache, { updates: live });
      persistCache(cache);
    } catch (_) { /* no updates file yet — harmless */ }
  }
  window.AFF.loadUpdatesFromRepo = loadUpdatesFromRepo;
  // [The rest of site-data.js — apply(), applyLanguage(), addLanguageControl(),
  //  cookie consent, update popup, all remaining functions — stays EXACTLY as in
  //  your file. Nothing else in this file references images, so no other changes.]
})();
