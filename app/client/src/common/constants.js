export const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'most_views', label: ' ↓ Views' },
  { value: 'least_views', label: '↑ Views' },
  { value: 'name_asc', label: 'Name A→Z' },
  { value: 'name_desc', label: 'Name Z→A' },
]
export const PRIVACY_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Private' },
]

export const AUTH_REQUIRED_PAGES = ['/', '/settings']

// Widths for the toolbar filter selects, shared by the videos and images pages
// so the two cannot drift apart. Sized from the longest option label plus
// react-select's own chrome (36px indicator, 8px value padding, 2px border):
// the sort labels need ~121px and the privacy labels ~93px, so the sm sizes
// never truncate. The xs sizes trade a little ellipsis on the two longest sort
// labels for a narrower control on small screens.
export const SORT_SELECT_WIDTH = { xs: 112, sm: 124 }
export const PRIVACY_SELECT_WIDTH = { xs: 92, sm: 96 }
// The tag filter shows "Tags", one tag's name or "3 tags", plus a clear button.
export const TAG_SELECT_WIDTH = { xs: 112, sm: 152 }
