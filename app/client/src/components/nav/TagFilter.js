import React from 'react'
import { Box } from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import Select, { components } from 'react-select'
import { folderSelectTheme } from '../../common/reactSelectThemes'

// A toolbar filter for the Home, Videos and Images pages: pick one or more tags
// and the page shows only media carrying every one of them, the same rule the
// search box applies to #tag terms.

const displayName = (name) => (name || '').replace(/_/g, ' ')

// The tags on a list of media, one option each, in alphabetical order.
export const tagOptionsFrom = (mediaList) => {
  const byId = new Map()
  mediaList.forEach((media) =>
    (media?.tags || []).forEach((tag) => {
      if (!byId.has(tag.id)) byId.set(tag.id, tag)
    }),
  )
  return [...byId.values()]
    .map((tag) => ({ value: tag.id, label: displayName(tag.name), color: tag.color }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
}

// Whether a piece of media carries every selected tag. Nothing selected matches all.
export const hasAllTags = (media, selected) =>
  !selected?.length || selected.every((option) => (media?.tags || []).some((tag) => tag.id === option.value))

// The page's tag options and selection. A tag that leaves the list (its last
// item deleted, say) drops out of the selection too.
export const useTagFilter = (mediaList) => {
  const options = React.useMemo(() => tagOptionsFrom(mediaList || []), [mediaList])
  const [selected, setSelected] = React.useState([])
  React.useEffect(() => {
    setSelected((current) => {
      const kept = current.filter((option) => options.some((o) => o.value === option.value))
      return kept.length === current.length ? current : kept
    })
  }, [options])
  return { options, selected, setSelected }
}

const TagOption = (props) => {
  const { data, isSelected, children } = props
  return (
    <components.Option {...props}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Box
          aria-hidden="true"
          sx={{
            width: 16,
            height: 16,
            flexShrink: 0,
            borderRadius: '4px',
            border: '1.5px solid',
            borderColor: isSelected ? '#3399FF' : '#FFFFFF55',
            bgcolor: isSelected ? '#3399FF' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {isSelected && <CheckIcon sx={{ fontSize: 13, color: 'white' }} />}
        </Box>
        <Box
          aria-hidden="true"
          sx={{ width: 8, height: 8, flexShrink: 0, borderRadius: '50%', bgcolor: data.color || '#2684FF' }}
        />
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {children}
        </Box>
      </Box>
    </components.Option>
  )
}

const stylesFor = (active) => ({
  ...folderSelectTheme,
  // With tags picked, the summary ("2 tags") reads as a value, not a hint.
  placeholder: (styles) => ({
    ...folderSelectTheme.placeholder(styles),
    color: active ? '#fff' : '#FFFFFF66',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }),
  input: (styles) => ({ ...styles, color: '#fff', fontSize: 14 }),
  clearIndicator: (styles) => ({
    ...styles,
    color: '#FFFFFF66',
    padding: '0 2px',
    '&:hover': { color: '#fff' },
  }),
  // The control is narrow; the menu is as wide as its tag names need.
  menu: (styles) => ({ ...folderSelectTheme.menu(styles), minWidth: 200 }),
})

const TagFilter = ({ options, value, onChange }) => {
  const summary = value.length === 0 ? 'Tags' : value.length === 1 ? value[0].label : `${value.length} tags`
  return (
    <Select
      isMulti
      aria-label="Filter by tags"
      options={options}
      value={value}
      onChange={(next) => onChange(next ? [...next] : [])}
      closeMenuOnSelect={false}
      hideSelectedOptions={false}
      controlShouldRenderValue={false}
      backspaceRemovesValue={false}
      isClearable
      placeholder={summary}
      noOptionsMessage={() => 'No matching tags'}
      styles={stylesFor(value.length > 0)}
      components={{ Option: TagOption }}
      menuPortalTarget={document.body}
      menuPosition="fixed"
    />
  )
}

export default TagFilter
