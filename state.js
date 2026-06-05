// js/state.js
// ─────────────────────────────────────────────────────────────
// Central state object and all static data (media types, labels)
// ─────────────────────────────────────────────────────────────

export const _state = {
  user: null,
  theme: 'dark',
  collection: [],
  wishlist: [],
  messages: [],
  trades: 0,
  view: 'grid',
  selectedType: null,
  editingItem: {},
  detailItem: null,
  lookupResult: null,
};

// Expose globally so Firebase module and inline handlers can reach it
window._state = _state;

// ── MEDIA TYPES ───────────────────────────────────────────────
export const MEDIA_TYPES = [
  { id:'cd',       icon:'💿', label:'CD',           fields:['artist','album','year','label','catalog','pressing','condition','format','notes'] },
  { id:'vinyl',    icon:'🎵', label:'Vinyl',         fields:['artist','album','year','label','catalog','pressing','speed','condition','notes'] },
  { id:'cassette', icon:'📼', label:'Cassette',      fields:['artist','album','year','label','condition','notes'] },
  { id:'book',     icon:'📗', label:'Book',          fields:['title','author','publisher','pub_year','isbn','edition','binding','condition','genre','language','notes'] },
  { id:'comic',    icon:'🦸', label:'Comic Book',    fields:['title','issue','publisher','pub_date','cover_artist','writer','penciler','inker','colorist','variant','print_run','edition_type','grade','grader','newsstand','printing','signed','stamp','condition','notes'], isComic:true },
  { id:'manga',    icon:'📘', label:'Manga',         fields:['title','volume','publisher','pub_year','author','edition','condition','notes'] },
  { id:'newspaper',icon:'📰', label:'Newspaper',     fields:['title','issue_date','headline','edition','condition','notes'] },
  { id:'magazine', icon:'📖', label:'Magazine',      fields:['title','issue','pub_date','publisher','condition','notes'] },
  { id:'game',     icon:'🎮', label:'Video Game',    fields:['title','platform','publisher','year','region','disc_count','condition','complete','notes'] },
  { id:'dvd',      icon:'📀', label:'DVD / Blu-ray', fields:['title','year','studio','format','region','condition','notes'] },
  { id:'vhs',      icon:'📹', label:'VHS',           fields:['title','year','studio','condition','notes'] },
  { id:'map',      icon:'🗺',  label:'Map / Poster',  fields:['title','publisher','year','size','condition','notes'] },
  { id:'photo',    icon:'🖼',  label:'Photograph',    fields:['subject','photographer','year','size','medium','condition','notes'] },
  { id:'other',    icon:'📦', label:'Other',         fields:['title','creator','year','type','condition','notes'] },
];

// ── FIELD LABELS ──────────────────────────────────────────────
export const FIELD_LABELS = {
  title:'Title', artist:'Artist / Band', author:'Author', album:'Album', year:'Year',
  pub_year:'Year', pub_date:'Publication Date', issue_date:'Issue Date', publisher:'Publisher',
  label:'Label', catalog:'Catalog #', pressing:'Pressing / Country', speed:'Speed (RPM)',
  condition:'Condition', format:'Format', notes:'Notes', isbn:'ISBN', edition:'Edition',
  binding:'Binding', genre:'Genre', language:'Language', issue:'Issue #',
  cover_artist:'Cover Artist', writer:'Writer', penciler:'Penciler', inker:'Inker',
  colorist:'Colorist', variant:'Variant', print_run:'Print Run', edition_type:'Edition Type',
  grade:'Grade', grader:'Graded By', newsstand:'Newsstand?', printing:'Printing #',
  signed:'Signed?', stamp:'Stamp / Sticker', headline:'Headline', volume:'Volume #',
  platform:'Platform', region:'Region', disc_count:'Disc Count', complete:'Complete in Box?',
  studio:'Studio', subject:'Subject', photographer:'Photographer', size:'Size / Dimensions',
  medium:'Medium', creator:'Creator', type:'Type / Category', pages:'Pages', description:'Description',
};

// ── COMIC-SPECIFIC PICKLISTS ──────────────────────────────────
export const COMIC_SPECIAL = {
  edition_type: [
    'Direct Edition','Newsstand','Whitman','Type 1A','Type 1B',
    'Canadian Price Variant','UK Price Variant','Australian Price Variant',
    'Mark Jewelers','35¢ Price Variant','File Copy',
  ],
  variant: [
    'Standard','2nd Print','3rd Print','Error / Misprint','Cover A','Cover B',
    'Foil','Embossed','Glow-in-dark','Polybag','Gatefold','Recalled',
    'Convention Exclusive','Retailer Incentive','Sketch Cover',
  ],
  grade: [
    'Ungraded','10.0 Gem Mint','9.9 Mint','9.8 NM/MT','9.6 NM+','9.4 NM',
    '9.2 NM-','9.0 VF/NM','8.5 VF+','8.0 VF','7.5 VF-','7.0 FN/VF','6.5 FN+',
    '6.0 FN','5.5 FN-','5.0 VG/FN','4.5 VG+','4.0 VG','3.5 VG-','3.0 GD/VG',
    '2.5 GD+','2.0 GD','1.8 GD-','1.5 FR/GD','1.0 FR','0.5 P',
  ],
  grader: ['CGC','CBCS','PGX','CGCC','Self-graded'],
};

export const CONDITION_OPTIONS = ['Mint','Near Mint','Very Fine','Fine','Very Good','Good','Fair','Poor'];
export const BINDING_OPTIONS   = ['Hardcover','Softcover / Paperback','Spiral','Sewn','Perfect Bound','Board Book','Leatherbound'];