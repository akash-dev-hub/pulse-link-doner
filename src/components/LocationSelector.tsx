import { useEffect, useMemo, useRef, useState } from 'react';
import { Country, State, City } from 'country-state-city';
import { ChevronDown, Loader2, MapPin, Search, X } from 'lucide-react';
import { lookupIndianPincode } from '../lib/locationApi.ts';
import type { LocationValue, ReverseGeocodeResult } from '../types.ts';

interface OptionItem {
  value: string;
  label: string;
  sublabel?: string;
}

interface SearchableDropdownProps {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  displayText: string;
  options: OptionItem[];
  disabled?: boolean;
  allowClear?: boolean;
  required?: boolean;
  emptyText?: string;
  onSelect: (option: OptionItem | null) => void;
}

function SearchableDropdown({
  id,
  label,
  placeholder,
  value,
  displayText,
  options,
  disabled = false,
  allowClear = false,
  required = false,
  emptyText = 'No matching results',
  onSelect,
}: SearchableDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter(
          (o) =>
            o.label.toLowerCase().includes(q) ||
            o.value.toLowerCase().includes(q) ||
            (o.sublabel && o.sublabel.toLowerCase().includes(q)),
        )
      : options;
    return list.slice(0, 120);
  }, [options, query]);

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor={id} className="block text-xs font-medium text-slate-700 mb-1.5">
        {label}
        {required && <span className="text-red-600 ml-0.5">*</span>}
      </label>
      <div className="relative flex items-center">
        <button
          id={id}
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen((prev) => !prev)}
          aria-expanded={open}
          className={`w-full min-h-[44px] px-3 py-2 text-left text-sm rounded-xl border transition-colors flex items-center justify-between gap-2 ${
            disabled
              ? 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed'
              : open
                ? 'bg-white border-red-500 ring-2 ring-red-500/15 text-slate-900'
                : 'bg-white border-slate-200 hover:border-slate-300 text-slate-900'
          }`}
        >
          <span className={`truncate ${displayText ? 'text-slate-900' : 'text-slate-400'}`}>
            {displayText || placeholder}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            {allowClear && value && !disabled && (
              <span
                role="button"
                tabIndex={0}
                aria-label={`Clear ${label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(null);
                  setOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelect(null);
                    setOpen(false);
                  }
                }}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-md"
              >
                <X className="w-3.5 h-3.5" />
              </span>
            )}
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
          </span>
        </button>
      </div>

      {open && !disabled && (
        <div className="absolute left-0 right-0 mt-1.5 z-40 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
          <div className="p-2 border-b border-slate-100 flex items-center gap-2 bg-slate-50/70">
            <Search className="w-4 h-4 text-slate-400 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}...`}
              className="w-full text-sm bg-transparent outline-none text-slate-900 placeholder:text-slate-400"
            />
          </div>
          <div className="max-h-60 overflow-y-auto divide-y divide-slate-100">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-xs text-slate-500 text-center">{emptyText}</div>
            ) : (
              filtered.map((opt) => {
                const active = opt.value === value;
                return (
                  <button
                    key={`${opt.value}-${opt.label}`}
                    type="button"
                    onClick={() => {
                      onSelect(opt);
                      setOpen(false);
                    }}
                    className={`w-full min-h-[40px] px-3 py-2 text-left text-sm flex items-center justify-between gap-2 transition-colors ${
                      active
                        ? 'bg-red-50 text-red-700 font-medium'
                        : 'text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <span className="truncate">{opt.label}</span>
                    {opt.sublabel && (
                      <span className="text-xs font-mono-tabular text-slate-400 shrink-0">
                        {opt.sublabel}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function matchReverseGeocodeToLocation(
  geo: ReverseGeocodeResult,
  current: LocationValue,
): LocationValue {
  const countries = Country.getAllCountries();
  const matchedCountry =
    countries.find((c) => c.isoCode.toUpperCase() === geo.countryCode.toUpperCase()) ||
    countries.find((c) => c.name.toLowerCase() === geo.countryName.toLowerCase());

  const countryCode = matchedCountry ? matchedCountry.isoCode : current.countryCode || 'IN';
  const countryName = matchedCountry ? matchedCountry.name : geo.countryName || current.countryName || 'India';

  const states = State.getStatesOfCountry(countryCode);
  const stateLower = geo.stateName.toLowerCase();
  const matchedState = states.find(
    (s) =>
      s.name.toLowerCase() === stateLower ||
      s.name.toLowerCase().includes(stateLower) ||
      stateLower.includes(s.name.toLowerCase()),
  );

  const stateCode = matchedState ? matchedState.isoCode : '';
  const stateName = matchedState ? matchedState.name : geo.stateName || '';

  let city = geo.city || '';
  if (stateCode) {
    const cities = City.getCitiesOfState(countryCode, stateCode);
    const cityLower = city.toLowerCase();
    const matchedCity = cities.find(
      (c) =>
        c.name.toLowerCase() === cityLower ||
        c.name.toLowerCase().includes(cityLower) ||
        cityLower.includes(c.name.toLowerCase()),
    );
    if (matchedCity) {
      city = matchedCity.name;
    }
  }

  return {
    countryCode,
    countryName,
    stateCode,
    stateName,
    city,
    locality: geo.locality || '',
    pincode: geo.pincode || '',
  };
}

interface LocationSelectorProps {
  value: LocationValue;
  onChange: (next: LocationValue) => void;
  mode?: 'form' | 'filter';
  showPincode?: boolean;
  requiredCity?: boolean;
  idPrefix?: string;
}

export function LocationSelector({
  value,
  onChange,
  mode = 'form',
  showPincode = true,
  requiredCity = mode === 'form',
  idPrefix = 'loc',
}: LocationSelectorProps) {
  const [manualCityMode, setManualCityMode] = useState(false);
  const [pinLoading, setPinLoading] = useState(false);
  const [pinError, setPinError] = useState('');
  const [pinSuggestions, setPinSuggestions] = useState<string[]>([]);
  const [pinHint, setPinHint] = useState('');

  const allCountries = useMemo<OptionItem[]>(
    () =>
      Country.getAllCountries().map((c) => ({
        value: c.isoCode,
        label: c.name,
        sublabel: c.isoCode,
      })),
    [],
  );

  const statesForCountry = useMemo<OptionItem[]>(() => {
    if (!value.countryCode) return [];
    return State.getStatesOfCountry(value.countryCode).map((s) => ({
      value: s.isoCode,
      label: s.name,
      sublabel: s.isoCode,
    }));
  }, [value.countryCode]);

  const citiesForState = useMemo<OptionItem[]>(() => {
    if (!value.countryCode || !value.stateCode) return [];
    return City.getCitiesOfState(value.countryCode, value.stateCode).map((c) => ({
      value: c.name,
      label: c.name,
    }));
  }, [value.countryCode, value.stateCode]);

  const isIndia = value.countryCode === 'IN';

  // Fetch Indian PIN code locality suggestions when 6 digits are entered
  useEffect(() => {
    const pin = value.pincode.trim();
    if (!showPincode || !isIndia || !/^\d{6}$/.test(pin)) {
      setPinSuggestions([]);
      setPinError('');
      setPinHint('');
      return;
    }

    let cancelled = false;
    setPinLoading(true);
    setPinError('');

    lookupIndianPincode(pin)
      .then((res) => {
        if (cancelled) return;
        setPinSuggestions(res.localities);
        if (res.district || res.state) {
          setPinHint([res.district, res.state].filter(Boolean).join(', '));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setPinSuggestions([]);
        setPinError(
          err instanceof Error
            ? `${err.message} You can type your locality manually below.`
            : 'Could not load PIN suggestions. Enter locality manually.',
        );
      })
      .finally(() => {
        if (!cancelled) setPinLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [value.pincode, isIndia, showPincode]);

  const handleCountryChange = (opt: OptionItem | null) => {
    setManualCityMode(false);
    setPinSuggestions([]);
    setPinError('');
    setPinHint('');
    if (!opt) {
      onChange({
        countryCode: '',
        countryName: '',
        stateCode: '',
        stateName: '',
        city: '',
        locality: '',
        pincode: '',
      });
      return;
    }
    onChange({
      countryCode: opt.value,
      countryName: opt.label,
      stateCode: '',
      stateName: '',
      city: '',
      locality: '',
      pincode: '',
    });
  };

  const handleStateChange = (opt: OptionItem | null) => {
    setManualCityMode(false);
    if (!opt) {
      onChange({
        ...value,
        stateCode: '',
        stateName: '',
        city: '',
        locality: '',
        pincode: '',
      });
      return;
    }
    onChange({
      ...value,
      stateCode: opt.value,
      stateName: opt.label,
      city: '',
      locality: '',
      pincode: '',
    });
  };

  const handleCityChange = (opt: OptionItem | null) => {
    if (!opt) {
      onChange({
        ...value,
        city: '',
        locality: '',
        pincode: '',
      });
      return;
    }
    onChange({
      ...value,
      city: opt.label,
      locality: '',
      pincode: '',
    });
  };

  const noCitiesInList = Boolean(value.stateCode) && citiesForState.length === 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SearchableDropdown
          id={`${idPrefix}-country`}
          label="Country"
          placeholder="Select country"
          value={value.countryCode}
          displayText={value.countryName}
          options={allCountries}
          required={mode === 'form'}
          allowClear={mode === 'filter'}
          onSelect={handleCountryChange}
        />

        <SearchableDropdown
          id={`${idPrefix}-state`}
          label="State / Region"
          placeholder={value.countryCode ? 'Select state' : 'Select country first'}
          value={value.stateCode}
          displayText={value.stateName}
          options={statesForCountry}
          disabled={!value.countryCode || statesForCountry.length === 0}
          allowClear
          onSelect={handleStateChange}
          emptyText="No states found"
        />

        <div>
          {manualCityMode || noCitiesInList ? (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor={`${idPrefix}-city-input`} className="block text-xs font-medium text-slate-700">
                  City{requiredCity && <span className="text-red-600 ml-0.5">*</span>}
                </label>
                {citiesForState.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setManualCityMode(false)}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Use list
                  </button>
                )}
              </div>
              <input
                id={`${idPrefix}-city-input`}
                type="text"
                value={value.city}
                onChange={(e) =>
                  onChange({
                    ...value,
                    city: e.target.value,
                  })
                }
                placeholder="Enter city name"
                className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              />
            </div>
          ) : (
            <div>
              <SearchableDropdown
                id={`${idPrefix}-city`}
                label="City"
                placeholder={
                  value.stateCode
                    ? 'Select city'
                    : statesForCountry.length === 0 && value.countryCode
                      ? 'Enter city manually'
                      : 'Select state first'
                }
                value={value.city}
                displayText={value.city}
                options={citiesForState}
                disabled={!value.countryCode || (!value.stateCode && statesForCountry.length > 0)}
                required={requiredCity}
                allowClear
                onSelect={handleCityChange}
              />
              {value.stateCode && (
                <button
                  type="button"
                  onClick={() => setManualCityMode(true)}
                  className="mt-1 text-xs text-slate-500 hover:text-slate-800 underline"
                >
                  City missing? Type manually
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={`grid grid-cols-1 ${showPincode ? 'sm:grid-cols-2' : ''} gap-3`}>
        {showPincode && (
          <div>
            <label htmlFor={`${idPrefix}-pincode`} className="block text-xs font-medium text-slate-700 mb-1.5">
              {isIndia ? 'PIN Code (6-digit for locality suggestions)' : 'Postal / ZIP Code'}
            </label>
            <div className="relative">
              <input
                id={`${idPrefix}-pincode`}
                type="text"
                inputMode={isIndia ? 'numeric' : 'text'}
                maxLength={isIndia ? 6 : 16}
                value={value.pincode}
                onChange={(e) => {
                  const next = isIndia ? e.target.value.replace(/\D/g, '').slice(0, 6) : e.target.value.slice(0, 16);
                  onChange({ ...value, pincode: next });
                }}
                placeholder={isIndia ? 'e.g. 560038' : 'Postal code (optional)'}
                className="w-full min-h-[44px] px-3 py-2 text-sm font-mono-tabular bg-white border border-slate-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
              />
              {pinLoading && (
                <Loader2 className="w-4 h-4 text-slate-400 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />
              )}
            </div>
            {pinHint && !pinError && (
              <p className="mt-1 text-xs text-slate-500">Post Office region: {pinHint}</p>
            )}
            {pinError && <p className="mt-1 text-xs text-amber-700">{pinError}</p>}
          </div>
        )}

        <div>
          <label htmlFor={`${idPrefix}-locality`} className="block text-xs font-medium text-slate-700 mb-1.5">
            Locality / Area {mode === 'filter' ? '(optional)' : ''}
          </label>
          <input
            id={`${idPrefix}-locality`}
            type="text"
            maxLength={120}
            value={value.locality}
            onChange={(e) => onChange({ ...value, locality: e.target.value })}
            placeholder="Neighborhood or area name"
            className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-200 rounded-xl focus:border-red-500 focus:ring-2 focus:ring-red-500/15 outline-none text-slate-900"
          />
          {pinSuggestions.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-slate-500 mb-1.5 flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5 text-red-600" />
                Suggested localities for {value.pincode} (tap to select or type manually):
              </p>
              <div className="flex flex-wrap gap-1.5">
                {pinSuggestions.slice(0, 10).map((locName) => {
                  const selected = value.locality.toLowerCase() === locName.toLowerCase();
                  return (
                    <button
                      key={locName}
                      type="button"
                      onClick={() => onChange({ ...value, locality: locName })}
                      className={`min-h-[34px] px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                        selected
                          ? 'bg-red-600 border-red-600 text-white font-medium'
                          : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {locName}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
