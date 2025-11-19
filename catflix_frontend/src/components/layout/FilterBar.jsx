import React from 'react';
import { SORT_OPTIONS } from '../../constants';

export function FilterBar({
  typeFilter,
  genreFilter,
  genres,
  releaseFilter,
  releaseOptions,
  sortOption,
  searchInput,
  openDropdown,
  onToggleType,
  onToggleGenre,
  onSetReleaseFilter,
  onSetSortOption,
  onSearchInputChange,
  onSearchSubmit,
  onToggleDropdown,
  onClearFilters,
  onStopPropagation
}) {
  return (
    <div className="filter-bar" onClick={onStopPropagation}>
      <div className="filter-group" onClick={onStopPropagation}>
        <button
          className={`filter-pill ${typeFilter.movie ? 'active' : ''}`}
          onClick={() => onToggleType('movie')}
        >
          Movies
        </button>
        <button
          className={`filter-pill ${typeFilter.show ? 'active' : ''}`}
          onClick={() => onToggleType('show')}
        >
          Shows
        </button>
        
        <div
          className={`dropdown ${openDropdown === 'genres' ? 'open' : ''}`}
          onClick={onStopPropagation}
        >
          <button
            className="filter-pill dropbtn"
            onClick={() => onToggleDropdown('genres')}
          >
            {genreFilter.length > 0 ? genreFilter.join(', ') : 'Genres'}
          </button>
          <div className="dropdown-content">
            {genres.map(g => (
              <label
                key={g}
                className={`dropdown-item ${genreFilter.includes(g) ? 'active' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={genreFilter.includes(g)}
                  onChange={() => onToggleGenre(g)}
                />
                {g}
              </label>
            ))}
          </div>
        </div>

        <div
          className={`dropdown release-dropdown ${openDropdown === 'release' ? 'open' : ''}`}
          onClick={onStopPropagation}
        >
          <button
            className="filter-pill dropbtn"
            onClick={() => onToggleDropdown('release')}
          >
            {releaseFilter || 'Release Date'}
          </button>
          <div className="dropdown-content">
            {releaseOptions.map(d => (
              <div
                key={d}
                className={`dropdown-item ${releaseFilter === d ? 'active' : ''}`}
                onClick={() => onSetReleaseFilter(releaseFilter === d ? '' : d)}
              >
                {d}
              </div>
            ))}
          </div>
        </div>

        <div
          className={`dropdown sort-dropdown ${openDropdown === 'sort' ? 'open' : ''}`}
          onClick={onStopPropagation}
        >
          <button
            className="filter-pill dropbtn"
            onClick={() => onToggleDropdown('sort')}
          >
            {sortOption}
          </button>
          <div className="dropdown-content">
            {SORT_OPTIONS.map(o => (
              <div
                key={o}
                className={`dropdown-item ${sortOption === o ? 'active' : ''}`}
                onClick={() => onSetSortOption(o)}
              >
                {o}
              </div>
            ))}
          </div>
        </div>

        <button
          className="filter-pill clearbtn"
          onClick={onClearFilters}
        >
          Clear Filters
        </button>

        <div className="search-container">
          <input
            type="text"
            className="search-input"
            placeholder="Search"
            value={searchInput}
            onChange={(e) => onSearchInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onSearchSubmit();
              }
            }}
          />
          <button className="search-btn" onClick={onSearchSubmit}>🔍</button>
        </div>
      </div>
    </div>
  );
}

