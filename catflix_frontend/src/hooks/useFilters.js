import { useState, useMemo } from 'react';

export function useFilters(movies, shows) {
  const [typeFilter, setTypeFilter] = useState({ movie: false, show: false });
  const [genreFilter, setGenreFilter] = useState([]);
  const [releaseFilter, setReleaseFilter] = useState('');
  const [sortOption, setSortOption] = useState('Title A-Z');
  const [searchTerm, setSearchTerm] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [openDropdown, setOpenDropdown] = useState(null);

  const passesFilters = (item) => {
    if ((typeFilter.movie || typeFilter.show) && !typeFilter[item.type]) return false;
    if (genreFilter.length > 0 && !item.meta?.genres?.some(g => genreFilter.includes(g.name))) return false;
    if (releaseFilter) {
      const dateStr = item.meta?.release_date || item.meta?.first_air_date;
      if (!dateStr) return false;
      const year = parseInt(dateStr.slice(0, 4), 10) || 0;
      if (`${Math.floor(year / 10) * 10}s` !== releaseFilter) return false;
    }
    if (searchTerm && !item.title.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  };

  const filteredMedia = useMemo(() => {
    return [...movies, ...shows]
      .filter(item => (!typeFilter.movie && !typeFilter.show) || typeFilter[item.type])
      .filter(item => genreFilter.length === 0 || item.meta?.genres?.some(g => genreFilter.includes(g.name)))
      .filter(item => {
        if (!releaseFilter) return true;
        const dateStr = item.meta?.release_date || item.meta?.first_air_date;
        if (!dateStr) return false;
        const year = parseInt(dateStr.slice(0, 4), 10) || 0;
        return `${Math.floor(year / 10) * 10}s` === releaseFilter;
      })
      .filter(item => !searchTerm || item.title.toLowerCase().includes(searchTerm.toLowerCase()))
      .sort((a, b) => {
        switch (sortOption) {
          case 'Title Z-A':
            return b.title.localeCompare(a.title);
          case 'Release Date (Newest)': {
            const aYear = parseInt((a.meta?.release_date || a.meta?.first_air_date || '').slice(0, 4), 10) || 0;
            const bYear = parseInt((b.meta?.release_date || b.meta?.first_air_date || '').slice(0, 4), 10) || 0;
            return bYear - aYear;
          }
          case 'Release Date (Oldest)': {
            const aYear = parseInt((a.meta?.release_date || a.meta?.first_air_date || '').slice(0, 4), 10) || 0;
            const bYear = parseInt((b.meta?.release_date || b.meta?.first_air_date || '').slice(0, 4), 10) || 0;
            return aYear - bYear;
          }
          default:
            return a.title.localeCompare(b.title);
        }
      });
  }, [movies, shows, typeFilter, genreFilter, releaseFilter, sortOption, searchTerm]);

  const toggleType = (t) => {
    setTypeFilter(prev => ({ ...prev, [t]: !prev[t] }));
  };

  const toggleGenre = (g) => {
    setGenreFilter(prev => prev.includes(g) ? [] : [g]);
  };

  const toggleDropdown = (name) => {
    setOpenDropdown(prev => prev === name ? null : name);
  };

  const closeAllDropdowns = () => setOpenDropdown(null);

  const clearFilters = () => {
    setTypeFilter({ movie: false, show: false });
    setGenreFilter([]);
    setReleaseFilter('');
    setSortOption('Title A-Z');
    setSearchTerm('');
    setSearchInput('');
    closeAllDropdowns();
  };

  return {
    typeFilter,
    genreFilter,
    releaseFilter,
    sortOption,
    searchTerm,
    searchInput,
    openDropdown,
    filteredMedia,
    passesFilters,
    toggleType,
    toggleGenre,
    setReleaseFilter,
    setSortOption,
    setSearchInput,
    setSearchTerm,
    toggleDropdown,
    closeAllDropdowns,
    clearFilters
  };
}

