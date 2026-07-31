use crate::messages::network::Client;
use graphene_std::text::Font;
use std::collections::HashMap;

// GraphX Studio fork (Track D, D1b): originally `https://api.graphite.art/font-list`.
// Repointed at a same-origin, relative Tool-Bridge endpoint so the embedded editor never
// phones home for fonts and instead serves the host's job + brand-kit font catalog. The
// response shape (`{items: [{family, variants, files}]}`) is unchanged, so no parsing logic
// below needed to change -- only the URL and where it's served from.
const FONT_LIST_API: &str = "/api/tools/graphite/font-list";

/// Resolves `FONT_LIST_API` (a same-origin path) against the page's own origin, since
/// `reqwest`'s `Url` parser (used by `Client::fetch` on every target, including wasm) requires
/// an absolute URL and will not accept a bare path. Falls back to the path itself if no
/// browser `window` is available (e.g. non-wasm test builds), which will simply fail to parse
/// as a URL and surface as a fetch error rather than panicking.
fn same_origin_font_list_url() -> String {
	web_sys::window()
		.and_then(|window| window.location().origin().ok())
		.map(|origin| format!("{origin}{FONT_LIST_API}"))
		.unwrap_or_else(|| FONT_LIST_API.to_string())
}

#[derive(serde::Deserialize)]
struct FontListApiResponse {
	items: Vec<FontListApiFamily>,
}

#[derive(serde::Deserialize)]
struct FontListApiFamily {
	family: String,
	variants: Vec<String>,
	files: HashMap<String, String>,
}

impl FontCatalog {
	pub async fn load_from_api(client: &Client) -> Option<Self> {
		let Some(bytes) = client.fetch(same_origin_font_list_url()).await else {
			log::error!("failed to fetch font catalog from API");
			return None;
		};

		let response: FontListApiResponse = match serde_json::from_slice(&bytes) {
			Ok(response) => response,
			Err(err) => {
				log::error!("failed to parse font catalog response: {err}");
				return None;
			}
		};

		let families = response
			.items
			.into_iter()
			.map(|family| {
				let styles = family
					.variants
					.iter()
					.filter_map(|variant| {
						let weight = variant.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse::<u32>().unwrap_or(400);
						let italic = variant.ends_with("italic");
						let url = family.files.get(variant)?.replacen("http://", "https://", 1);
						Some(FontCatalogStyle { weight, italic, url })
					})
					.collect();
				FontCatalogFamily { name: family.family, styles }
			})
			.collect();

		Some(Self(families))
	}
}

// TODO: Should this be a BTreeMap instead?
#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FontCatalog(Vec<FontCatalogFamily>);

impl FontCatalog {
	pub fn find_font_style_in_catalog(&self, font: &Font) -> Option<FontCatalogStyle> {
		let family = self.0.iter().find(|family| family.name == font.font_family);

		let found_style = family.map(|family| {
			let FontCatalogStyle { weight, italic, .. } = FontCatalogStyle::from_named_style(&font.font_style, "");
			family.closest_style(weight, italic).clone()
		});

		if found_style.is_none() {
			log::warn!("Font not found in catalog: {:?}", font);
		}

		found_style
	}

	pub fn download_url(&self, font: &Font) -> Option<String> {
		let catalog_family = self.0.iter().find(|catalog_family| catalog_family.name == font.font_family)?;
		let FontCatalogStyle { weight, italic, .. } = FontCatalogStyle::from_named_style(&font.font_style, "");
		Some(catalog_family.closest_style(weight, italic).url.clone())
	}

	pub fn normalize(&self, font: Font) -> Font {
		match self.find_font_style_in_catalog(&font) {
			Some(style) => Font::new(font.font_family, style.to_named_style()),
			None => font,
		}
	}

	pub fn iter(&self) -> impl Iterator<Item = &FontCatalogFamily> {
		self.0.iter()
	}

	pub fn is_empty(&self) -> bool {
		self.0.is_empty()
	}
}

impl From<Vec<FontCatalogFamily>> for FontCatalog {
	fn from(value: Vec<FontCatalogFamily>) -> Self {
		Self(value)
	}
}

#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FontCatalogFamily {
	/// The font family name.
	pub name: String,
	/// The font styles (variants) available for the font family.
	pub styles: Vec<FontCatalogStyle>,
}

impl FontCatalogFamily {
	/// Finds the closest style to the given weight and italic setting.
	/// Aims to find the nearest weight while maintaining the italic setting if possible, but italic may change if no other option is available.
	pub fn closest_style(&self, weight: u32, italic: bool) -> &FontCatalogStyle {
		static FALLBACK_STYLE: FontCatalogStyle = FontCatalogStyle {
			weight: 400,
			italic: false,
			url: String::new(),
		};

		self.styles
			.iter()
			.map(|style| ((style.weight as i32 - weight as i32).unsigned_abs() + 10000 * (style.italic != italic) as u32, style))
			.min_by_key(|(distance, _)| *distance)
			.map(|(_, style)| style)
			.unwrap_or(self.styles.first().unwrap_or(&FALLBACK_STYLE))
	}
}

#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FontCatalogStyle {
	pub weight: u32,
	pub italic: bool,
	pub url: String,
}

impl FontCatalogStyle {
	pub fn to_named_style(&self) -> String {
		let weight = self.weight;
		let italic = self.italic;

		let named_weight = Font::named_weight(weight);
		let maybe_italic = if italic { " Italic" } else { "" };

		format!("{named_weight}{maybe_italic} ({weight})")
	}

	pub fn from_named_style(named_style: &str, url: impl Into<String>) -> FontCatalogStyle {
		let weight = named_style.split_terminator(['(', ')']).next_back().and_then(|x| x.parse::<u32>().ok()).unwrap_or(400);
		let italic = named_style.contains("Italic (");
		FontCatalogStyle { weight, italic, url: url.into() }
	}

	/// GraphX Studio fork (Track D, D1b): dropped. This previously built a
	/// `https://fonts.googleapis.com/css2?...` URL (Google Fonts' CSS API) to load a live
	/// font-preview stylesheet for the font-family dropdown. We have no same-origin
	/// equivalent of that per-family, per-weight subsetted CSS service, and the zero-external-
	/// network requirement (D1b AC1) forbids calling the real one. Returning an empty string
	/// is a clean drop, not a broken link: `MenuList.svelte` only renders the `<link>` preview
	/// element `{#if entry.font}` (a JS/TS truthiness check), so an empty string is treated
	/// exactly like "no preview" -- the dropdown still shows the family name, just rendered in
	/// the UI's default font instead of its own. No frontend change was needed for this.
	pub fn preview_url(&self, _family: impl Into<String>) -> String {
		String::new()
	}
}
