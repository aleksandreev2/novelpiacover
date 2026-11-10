use std::{
    cell::RefCell,
    collections::HashSet,
    fmt,
    io::Read,
    sync::LazyLock,
    time::{Duration, Instant},
};

use anyhow::{anyhow, ensure, Result};
use chrono::{DateTime, Utc};
use html5ever::tokenizer::{
    states::RawKind, BufferQueue, Tag, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer,
};
use regex::Regex;
use reqwest::header::{ACCEPT, CACHE_CONTROL, LOCATION, REFERER, RETRY_AFTER};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use url::Url;

const BASE: &str = "https://novelpia.com/";
const NOVEL_URL_HINT: &str = "Нужна ссылка вида https://novelpia.com/novel/434103";
const IMAGE_URL_ERROR: &str = "Недопустимая ссылка или домен изображения.";
const TIMEOUT: Duration = Duration::from_secs(30);
const TIMEOUT_ERROR: &str = "Истекло время ожидания ответа (30 секунд).";
const SIZE_ERROR: &str = "Превышен допустимый размер ответа.";
const MAX_PAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 30 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

static BASE_URL: LazyLock<Url> = LazyLock::new(|| Url::parse(BASE).unwrap());
static HIDDEN_STYLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b").unwrap()
});
static AWARD_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^/img/new/icon/[a-z0-9_-]*pencil[a-z0-9_-]*\.(?:png|gif|webp|svg)$").unwrap()
});
static TITLE_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^노벨피아\s*-\s*웹소설로 꿈꾸는 세상!\s*-\s*").unwrap());

fn valid_authority(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

fn novel_id(url: &Url) -> Result<&str> {
    let id = url.path().strip_prefix("/novel/").unwrap_or_default();
    let id = id.strip_suffix('/').unwrap_or(id);
    ensure!(
        valid_authority(url)
            && matches!(url.host_str(), Some("novelpia.com" | "www.novelpia.com"))
            && !id.is_empty()
            && id.len() <= 12
            && !id.starts_with('0')
            && id.bytes().all(|byte| byte.is_ascii_digit()),
        NOVEL_URL_HINT
    );
    Ok(id)
}

fn checked_page_url(input: &str) -> Result<Url> {
    ensure!(
        input.encode_utf16().count() <= 2048,
        "Введите ссылку на новеллу Novelpia."
    );
    let url = Url::parse(input.trim_matches(js_whitespace))
        .map_err(|_| anyhow!("Неверная ссылка Novelpia."))?;
    novel_id(&url)?;
    Ok(url)
}

pub fn parse_novel_url(input: &str) -> Result<(String, String)> {
    let url = checked_page_url(input)?;
    let id = novel_id(&url)?;
    Ok((id.to_owned(), format!("{BASE}novel/{id}")))
}

pub(crate) fn validate_image_url(url: &Url) -> Result<()> {
    let file = url
        .path()
        .strip_prefix("/imagebox/cover/")
        .unwrap_or_default();
    ensure!(
        valid_authority(url)
            && matches!(
                url.host_str(),
                Some(
                    "novelpia.com"
                        | "www.novelpia.com"
                        | "images.novelpia.com"
                        | "image.novelpia.com"
                )
            )
            && !file.is_empty()
            && !file.contains('/'),
        IMAGE_URL_ERROR
    );
    Ok(())
}

fn parse_image_url(input: &str) -> Result<Url> {
    let mut url = BASE_URL.join(input).map_err(|_| anyhow!(IMAGE_URL_ERROR))?;
    validate_image_url(&url)?;
    url.set_fragment(None);
    Ok(url)
}

fn js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}'
}

fn collapse_whitespace(text: &str) -> String {
    text.split(js_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate_utf16(text: &str, max_units: usize) -> &str {
    let mut units = 0;
    for (offset, character) in text.char_indices() {
        units += character.len_utf16();
        if units > max_units {
            return &text[..offset];
        }
    }
    text
}

pub fn safe_folder(title: &str, id: &str) -> String {
    let cleaned = title
        .replace(['<', '>', ':', '"', '/', '\\', '|', '?', '*'], " ")
        .replace(|character: char| character <= '\u{001f}', " ");
    let collapsed = collapse_whitespace(&cleaned);
    let name = truncate_utf16(collapsed.trim_matches(['.', ' ']), 90).trim_end();
    let name = if name.is_empty() { "Novelpia" } else { name };
    format!("{name} [{id}]")
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Source {
    pub kind: String,
    pub url: String,
}

pub struct Page {
    pub title: Option<String>,
    pub sources: Vec<Source>,
    pub status: Option<String>,
    pub status_reason: String,
}

// A small tree over real tokenizer events preserves whether each node ended with its own
// closing tag. An HTML DOM repairs missing end tags, which can turn truncated badges into
// apparent evidence that a novel is ongoing.
enum NodeKind {
    Root,
    Element(Tag),
    Text(String),
}

struct Node {
    kind: NodeKind,
    parent: usize,
    children: Vec<usize>,
    closed: bool,
}

impl Node {
    fn name(&self) -> &str {
        match &self.kind {
            NodeKind::Element(tag) => &tag.name,
            _ => "",
        }
    }

    fn attr(&self, name: &str) -> Option<&str> {
        match &self.kind {
            NodeKind::Element(tag) => tag
                .attrs
                .iter()
                .find(|attr| attr.name.local.as_ref() == name)
                .map(|attr| attr.value.as_ref()),
            _ => None,
        }
    }

    fn classes(&self) -> impl Iterator<Item = &str> {
        self.attr("class").unwrap_or_default().split(js_whitespace)
    }

    fn has_class(&self, name: &str) -> bool {
        self.classes().any(|class| class == name)
    }

    fn hidden(&self) -> bool {
        self.attr("hidden").is_some()
            || self
                .attr("style")
                .is_some_and(|style| HIDDEN_STYLE.is_match(style))
    }

    fn ignored(&self) -> bool {
        matches!(self.name(), "script" | "style" | "template" | "noscript") || self.hidden()
    }
}

struct Markup {
    nodes: Vec<Node>,
    open: Vec<usize>,
    limited: bool,
}

impl Markup {
    fn parse(html: &str) -> Self {
        let markup = Self {
            nodes: vec![Node {
                kind: NodeKind::Root,
                parent: 0,
                children: Vec::new(),
                closed: true,
            }],
            open: vec![0],
            limited: false,
        };
        let tokenizer = Tokenizer::new(Sink(RefCell::new(markup)), Default::default());
        let input = BufferQueue::default();
        input.push_back(html.into());
        let _ = tokenizer.feed(&input);
        tokenizer.end();
        tokenizer.sink.0.into_inner()
    }

    fn append(&mut self, kind: NodeKind) -> usize {
        let parent = *self.open.last().unwrap();
        let id = self.nodes.len();
        self.nodes[parent].children.push(id);
        self.nodes.push(Node {
            kind,
            parent,
            children: Vec::new(),
            closed: false,
        });
        id
    }

    fn append_text(&mut self, text: &str) {
        let parent = *self.open.last().unwrap();
        if let Some(&id) = self.nodes[parent].children.last() {
            if let NodeKind::Text(value) = &mut self.nodes[id].kind {
                value.push_str(text);
                return;
            }
        }
        self.append(NodeKind::Text(text.to_owned()));
    }

    fn start(&mut self, tag: Tag) -> TokenSinkResult<()> {
        let name = tag.name.as_ref();
        while self.open.len() > 1
            && implies_close(name, self.nodes[*self.open.last().unwrap()].name())
        {
            self.open.pop();
        }
        let void = matches!(
            name,
            "area"
                | "base"
                | "basefont"
                | "br"
                | "col"
                | "command"
                | "embed"
                | "frame"
                | "hr"
                | "img"
                | "input"
                | "isindex"
                | "keygen"
                | "link"
                | "meta"
                | "param"
                | "source"
                | "track"
                | "wbr"
        );
        let foreign = tag.self_closing
            && (matches!(name, "svg" | "math")
                || self
                    .open
                    .iter()
                    .any(|&id| matches!(self.nodes[id].name(), "svg" | "math")));
        let mode = match name {
            "script" => TokenSinkResult::RawData(RawKind::ScriptData),
            "title" | "textarea" => TokenSinkResult::RawData(RawKind::Rcdata),
            "style" | "xmp" | "iframe" | "noembed" | "noframes" | "noscript" => {
                TokenSinkResult::RawData(RawKind::Rawtext)
            }
            "plaintext" => TokenSinkResult::Plaintext,
            _ => TokenSinkResult::Continue,
        };
        let id = self.append(NodeKind::Element(tag));
        if !void && !foreign {
            self.open.push(id);
        }
        mode
    }

    fn end(&mut self, tag: &Tag) {
        if let Some(index) = self
            .open
            .iter()
            .rposition(|&id| self.nodes[id].name() == tag.name.as_ref())
        {
            // A malformed end tag with attributes did not count as a closing tag in the original parser.
            self.nodes[self.open[index]].closed = tag.attrs.is_empty() && !tag.self_closing;
            self.open.truncate(index);
        }
    }

    fn visible(&self, root: usize) -> impl Iterator<Item = usize> + '_ {
        let mut stack = vec![root];
        std::iter::from_fn(move || {
            while let Some(id) = stack.pop() {
                let node = &self.nodes[id];
                if !node.ignored() {
                    stack.extend(node.children.iter().rev().copied());
                    return Some(id);
                }
            }
            None
        })
    }

    fn by_class(&self, root: usize, class: &str) -> Option<usize> {
        self.visible(root)
            .find(|&id| self.nodes[id].has_class(class))
    }

    fn text(&self, root: usize) -> String {
        self.visible(root)
            .filter_map(|id| match &self.nodes[id].kind {
                NodeKind::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }
}

fn implies_close(next: &str, current: &str) -> bool {
    match next {
        "tr" => matches!(current, "tr" | "th" | "td"),
        "td" => matches!(current, "thead" | "th" | "td"),
        "body" => matches!(current, "head" | "link" | "script"),
        "th" | "a" | "li" | "option" => current == next,
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            matches!(current, "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
        }
        "select" | "input" | "output" | "button" | "datalist" | "textarea" => matches!(
            current,
            "input" | "option" | "optgroup" | "select" | "button" | "datalist" | "textarea"
        ),
        "optgroup" => matches!(current, "optgroup" | "option"),
        "dd" | "dt" => matches!(current, "dd" | "dt"),
        "rt" | "rp" => matches!(current, "rt" | "rp"),
        "tbody" | "tfoot" => matches!(current, "thead" | "tbody"),
        "p" | "address" | "article" | "aside" | "blockquote" | "details" | "div" | "dl"
        | "fieldset" | "figcaption" | "figure" | "footer" | "form" | "header" | "hr" | "main"
        | "nav" | "ol" | "pre" | "section" | "table" | "ul" => current == "p",
        _ => false,
    }
}

struct Sink(RefCell<Markup>);

impl TokenSink for Sink {
    type Handle = ();

    fn process_token(&self, token: Token, _line: u64) -> TokenSinkResult<()> {
        let mut markup = self.0.borrow_mut();
        if markup.limited || markup.nodes.len() >= 200_000 || markup.open.len() > 512 {
            markup.limited = true;
            return TokenSinkResult::Continue;
        }
        match token {
            Token::TagToken(tag) if tag.kind == TagKind::StartTag => return markup.start(tag),
            Token::TagToken(tag) => markup.end(&tag),
            Token::CharacterTokens(text) => markup.append_text(&text),
            Token::NullCharacterToken => markup.append_text("\0"),
            _ => (),
        }
        TokenSinkResult::Continue
    }
}

fn compact(text: &str) -> String {
    text.nfkc()
        .filter(|&c| !js_whitespace(c) && c != '\u{200b}')
        .collect()
}

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
enum Lifecycle {
    Ongoing,
    Completed,
    Discontinued,
    Delayed,
}

impl Lifecycle {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "연재중" => Some(Self::Ongoing),
            "완결" => Some(Self::Completed),
            "연재중단" => Some(Self::Discontinued),
            "연재지연" => Some(Self::Delayed),
            _ => None,
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::Ongoing => "ongoing",
            Self::Completed => "completed",
            Self::Discontinued => "discontinued",
            Self::Delayed => "delayed",
        }
    }
}

fn normal_label(value: &str) -> bool {
    matches!(
        value,
        "" | "PLUS"
            | "독점"
            | "자유"
            | "무료"
            | "유료"
            | "15"
            | "19"
            | "전체"
            | "전체이용가"
            | "공모전"
            | "우주최강"
            | "챌린지"
            | "연재"
            | "신작"
            | "선독점"
            | "독점공개"
    )
}

fn classify(text: &str) -> Option<HashSet<Lifecycle>> {
    let value = compact(text);
    if normal_label(&value) {
        return Some(HashSet::new());
    }
    if let Some(code) = Lifecycle::parse(&value) {
        return Some(HashSet::from([code]));
    }
    let mut codes = HashSet::new();
    let mut count = 0;
    for part in text.split(js_whitespace).filter(|part| !part.is_empty()) {
        let part = compact(part);
        count += 1;
        if let Some(code) = Lifecycle::parse(&part) {
            codes.insert(code);
        } else if part.is_empty() || !normal_label(&part) {
            return None;
        }
    }
    (count > 1).then_some(codes)
}

fn award_image(node: &Node) -> bool {
    node.attr("src")
        .and_then(|src| BASE_URL.join(src).ok())
        .is_some_and(|url| {
            valid_authority(&url)
                && matches!(
                    url.host_str(),
                    Some("images.novelpia.com" | "image.novelpia.com" | "novelpia.com")
                )
                && AWARD_PATH.is_match(url.path())
        })
}

#[derive(Default)]
struct Badge {
    text: String,
    residue: String,
    text_codes: HashSet<Lifecycle>,
    structural_codes: HashSet<Lifecycle>,
    opaque: bool,
}

impl Badge {
    fn read(markup: &Markup, id: usize, depth: usize) -> Self {
        let mut badge = Self::default();
        if depth > 40 {
            badge.opaque = true;
            return badge;
        }
        let node = &markup.nodes[id];
        if node.ignored()
            || node.classes().any(|class| {
                matches!(
                    class,
                    "b_plus"
                        | "b_mono"
                        | "b_free"
                        | "b_15"
                        | "b_19"
                        | "b_million_class"
                        | "b_contest"
                        | "b_challenge"
                )
            })
        {
            return badge;
        }
        if let NodeKind::Text(text) = &node.kind {
            badge.text.clone_from(text);
            badge.residue.clone_from(text);
            return badge;
        }
        if node.has_class("b_comp") {
            badge.structural_codes.insert(Lifecycle::Completed);
        }
        match node.name() {
            "img" if award_image(node) => return Self::default(),
            "img" => {
                if let Some(code) = Lifecycle::parse(&compact(node.attr("alt").unwrap_or_default()))
                {
                    badge.structural_codes.insert(code);
                } else {
                    badge.opaque = true;
                }
                return badge;
            }
            "svg" | "canvas" | "object" | "iframe" | "video" => {
                badge.opaque = true;
                return badge;
            }
            _ => (),
        }
        for &child in &node.children {
            let child = Self::read(markup, child, depth + 1);
            badge.text.push_str(&child.text);
            badge.residue.push_str(&child.residue);
            badge.text_codes.extend(child.text_codes);
            badge.structural_codes.extend(child.structural_codes);
            badge.opaque |= child.opaque;
        }
        if let Some(whole) = classify(&badge.text) {
            // The whole formatted word supersedes any prefixes inside its wrappers.
            // Image and class evidence remains independent.
            if !whole.is_empty() {
                badge.text_codes = whole;
            }
            badge.residue.clear();
        } else if let Some(rest) = classify(&badge.residue) {
            badge.text_codes.extend(rest);
            badge.residue.clear();
        }
        badge
    }

    fn status(mut self) -> (&'static str, String) {
        self.text_codes.extend(self.structural_codes);
        if self.text_codes.len() > 1 {
            return unknown("На странице обнаружены противоречивые метки статуса.");
        }
        if let Some(&code) = self.text_codes.iter().next() {
            if code != Lifecycle::Ongoing {
                return (code.code(), String::new());
            }
        }
        if self.opaque {
            return unknown("В блоке статуса обнаружен незнакомый графический значок.");
        }
        let residue = collapse_whitespace(&self.residue);
        if !residue.is_empty() {
            return (
                "unknown",
                format!(
                    "Не распознаны метки страницы: {}",
                    truncate_utf16(&residue, 100)
                ),
            );
        }
        (Lifecycle::Ongoing.code(), String::new())
    }
}

fn unknown(reason: &str) -> (&'static str, String) {
    ("unknown", reason.to_owned())
}

fn inspect_status(markup: &Markup) -> (&'static str, String) {
    let Some(title) = markup
        .by_class(0, "epnew-novel-title")
        .filter(|&id| markup.nodes[id].closed)
    else {
        return unknown("На странице не найден полный заголовок тайтла.");
    };
    let mut writer = None;
    for &id in markup.nodes[markup.nodes[title].parent]
        .children
        .iter()
        .skip_while(|&&id| id != title)
        .skip(1)
    {
        let node = &markup.nodes[id];
        if node.has_class("epnew-writer") {
            writer = Some(id);
            break;
        }
        if node.has_class("epnew-novel-title") {
            return unknown("Не найден основной блок автора.");
        }
        if let NodeKind::Text(text) = &node.kind {
            if !text.trim_matches(js_whitespace).is_empty() {
                return unknown("Не распознана структура основного блока тайтла.");
            }
        } else if !node.ignored() && !matches!(node.name(), "br" | "hr" | "meta") {
            return unknown("Между заголовком и автором находится другая секция страницы.");
        }
    }
    let byline = writer
        .filter(|&id| markup.nodes[id].closed)
        .and_then(|id| markup.by_class(id, "in-writer").map(|byline| (id, byline)));
    let Some((writer, byline)) = byline else {
        return unknown("Не найден полный основной блок автора.");
    };
    let author = markup.by_class(byline, "writer-name").unwrap_or(byline);
    if !markup
        .visible(author)
        .any(|id| match &markup.nodes[id].kind {
            NodeKind::Text(text) => !matches!(compact(text).as_str(), "" | "작가명"),
            _ => false,
        })
    {
        return unknown("Основной блок автора не заполнен.");
    }
    let Some(badge) = markup
        .by_class(writer, "in-badge")
        .filter(|&id| markup.nodes[id].closed)
    else {
        return unknown("Блок меток статуса отсутствует или не полностью загружен.");
    };
    Badge::read(markup, badge, 0).status()
}

pub fn inspect_page(input: &str) -> Page {
    let markup = Markup::parse(input);
    if markup.limited {
        return Page {
            title: None,
            sources: Vec::new(),
            status: Some("unknown".to_owned()),
            status_reason: "Структура страницы слишком сложна для проверки статуса.".to_owned(),
        };
    }
    let mut og_title = None;
    let mut og_image = None;
    let mut cover = None;
    let mut cover_link = None;
    let mut title_id = None;
    for id in markup.visible(0) {
        let node = &markup.nodes[id];
        match node.name() {
            "meta" => match node
                .attr("property")
                .filter(|value| !value.is_empty())
                .or_else(|| node.attr("name"))
            {
                Some("og:title") => og_title = node.attr("content"),
                Some("og:image") => og_image = node.attr("content"),
                _ => (),
            },
            "img" if node.has_class("cover_img") => {
                cover.get_or_insert(id);
                if cover_link.is_none() {
                    let mut parent = node.parent;
                    while parent != 0 {
                        let ancestor = &markup.nodes[parent];
                        if ancestor.name() == "a" && ancestor.closed {
                            cover_link = Some(parent);
                            break;
                        }
                        parent = ancestor.parent;
                    }
                }
            }
            "div" | "h1" | "span" if title_id.is_none() && node.has_class("epnew-novel-title") => {
                title_id = Some(id)
            }
            _ => (),
        }
    }

    let original = cover_link.and_then(|id| markup.nodes[id].attr("href"));
    let thumbnail = cover
        .and_then(|id| markup.nodes[id].attr("src"))
        .filter(|src| !src.is_empty())
        .or(og_image);
    let mut sources = Vec::<Source>::new();
    for (kind, candidate) in [("original", original), ("cover", thumbnail)] {
        if let Some(url) = candidate
            .and_then(|value| parse_image_url(value).ok())
            .map(String::from)
        {
            if !sources.iter().any(|source| source.url == url) {
                sources.push(Source {
                    kind: kind.to_owned(),
                    url,
                });
            }
        }
    }
    let title = match title_id {
        Some(id) if markup.nodes[id].closed => Some(markup.text(id)),
        // Metadata alone also appears on login and error pages. Require a cover
        // for this fallback, and skip it entirely when explicit markup is truncated.
        None if !sources.is_empty() => {
            og_title.map(|title| TITLE_PREFIX.replace(title, "").into_owned())
        }
        _ => None,
    }
    .map(|title| collapse_whitespace(&title))
    .filter(|title| !title.is_empty())
    .map(|title| truncate_utf16(&title, 300).to_owned());
    let (status, status_reason) = inspect_status(&markup);
    Page {
        title,
        sources,
        status: Some(status.to_owned()),
        status_reason,
    }
}

pub struct Client(reqwest::blocking::Client);

#[derive(Debug)]
pub struct FetchError {
    message: String,
    pub retry_after_ms: u64,
}

impl FetchError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retry_after_ms: 0,
        }
    }
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FetchError {}

impl Client {
    pub fn new() -> Result<Self> {
        Ok(Self(
            reqwest::blocking::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .referer(false)
                .user_agent("NovelpiaCover/2.0")
                .build()?,
        ))
    }

    pub fn fetch(&self, input: &str, image: bool) -> Result<Vec<u8>, FetchError> {
        let deadline = Instant::now() + TIMEOUT;
        let mut url = if image {
            parse_image_url(input)
        } else {
            checked_page_url(input)
        }
        .map_err(|error| FetchError::new(error.to_string()))?;
        let (accept, limit) = if image {
            (
                "image/png,image/jpeg,image/webp,image/*;q=0.8",
                MAX_IMAGE_BYTES,
            )
        } else {
            ("text/html", MAX_PAGE_BYTES)
        };
        for redirect in 0..=MAX_REDIRECTS {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(FetchError::new(TIMEOUT_ERROR));
            }
            let mut response = self
                .0
                .get(url.clone())
                .timeout(remaining)
                .header(ACCEPT, accept)
                .header(CACHE_CONTROL, "no-cache")
                .header(REFERER, BASE)
                .send()
                .map_err(|error| {
                    if error.is_timeout() {
                        FetchError::new(TIMEOUT_ERROR)
                    } else {
                        FetchError::new("Не удалось получить ответ Novelpia.")
                    }
                })?;
            let status = response.status().as_u16();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                if redirect == MAX_REDIRECTS {
                    return Err(FetchError::new("Слишком много перенаправлений."));
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| FetchError::new("Сервер вернул перенаправление без ссылки."))?;
                let next = url
                    .join(location)
                    .map_err(|_| FetchError::new("Недопустимая ссылка перенаправления."))?;
                url = if image {
                    parse_image_url(next.as_str())
                } else {
                    checked_page_url(next.as_str())
                }
                .map_err(|error| FetchError::new(error.to_string()))?;
                continue;
            }
            if !response.status().is_success() {
                let extra = if matches!(status, 401 | 403) {
                    " Страница недоступна без авторизации или заблокирована."
                } else {
                    ""
                };
                let mut error = FetchError::new(format!("Сервер ответил HTTP {status}.{extra}"));
                if matches!(status, 429 | 503) {
                    let value = response
                        .headers()
                        .get(RETRY_AFTER)
                        .and_then(|value| value.to_str().ok());
                    error.retry_after_ms = retry_after_ms(value, Utc::now());
                }
                return Err(error);
            }
            if response
                .content_length()
                .is_some_and(|size| size > limit as u64)
            {
                return Err(FetchError::new(SIZE_ERROR));
            }
            let body = read_limited(&mut response, limit);
            if Instant::now() >= deadline {
                return Err(FetchError::new(TIMEOUT_ERROR));
            }
            return body;
        }
        unreachable!("every response returns or consumes one redirect")
    }
}

fn read_limited(reader: &mut impl Read, limit: usize) -> Result<Vec<u8>, FetchError> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| FetchError::new("Не удалось прочитать ответ Novelpia."))?;
    if bytes.len() > limit {
        return Err(FetchError::new(SIZE_ERROR));
    }
    if bytes.is_empty() {
        return Err(FetchError::new("Сервер вернул пустой ответ."));
    }
    Ok(bytes)
}

fn retry_after_ms(header: Option<&str>, now: DateTime<Utc>) -> u64 {
    let delay = header
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.bytes().all(|byte| byte.is_ascii_digit()) {
                return value
                    .parse::<u64>()
                    .unwrap_or(u64::MAX)
                    .saturating_mul(1000);
            }
            DateTime::parse_from_rfc2822(value)
                .map(|time| time.signed_duration_since(now).num_milliseconds().max(0) as u64)
                .unwrap_or(60_000)
        })
        .unwrap_or(60_000);
    delay.clamp(60_000, 86_400_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct StatusFixture {
        id: String,
        expected: String,
        html: String,
    }

    #[test]
    fn reads_all_recorded_novelpia_headers() {
        let fixtures: Vec<StatusFixture> = serde_json::from_str(include_str!(
            "../../tests/fixtures/novelpia-status-pages.json"
        ))
        .unwrap();
        assert_eq!(fixtures.len(), 59);
        for fixture in fixtures {
            let page = inspect_page(&fixture.html);
            assert_eq!(
                page.status.as_deref(),
                Some(fixture.expected.as_str()),
                "{}: {}",
                fixture.id,
                page.status_reason,
            );
            assert!(page.title.is_some());
            assert!(page.sources.is_empty());
        }
    }

    fn header(badges: &str) -> String {
        format!(
            r#"<DIV class='epnew-novel-title'>Book</DIV><!-- author --><div class="epnew-writer"><p class="in-writer">Author</p><p class="in-badge">{badges}</p></div>"#
        )
    }

    #[test]
    fn reconciles_nested_words_and_keeps_independent_evidence() {
        for (markup, status) in [
            ("<span>완<b>결</b></span>", "completed"),
            ("<span>&#50756;&#44208;</span>", "completed"),
            ("<span><b>연재중</b>단</span>", "discontinued"),
            ("<b>연재</b>지연", "delayed"),
            ("<span>완결</span><span>연재중단</span>", "unknown"),
            ("<span>연재중</span><span>휴재</span>", "unknown"),
            ("<span>연재중</span><img src='/new-badge.png'>", "unknown"),
            ("<span class='b_comp'></span>", "completed"),
            ("<img alt='연재지연'>", "delayed"),
            ("<span>ＰＬＵＳ</span><span>연재​중</span>", "ongoing"),
        ] {
            assert_eq!(
                inspect_page(&header(markup)).status.as_deref(),
                Some(status),
                "{markup}"
            );
        }
    }

    #[test]
    fn ignores_awards_hidden_text_and_sales_badges() {
        let page = inspect_page(&header(concat!(
            "<span hidden>완결</span><span style='visibility : hidden'>연재중단</span>",
            "<template><span>연재지연</span></template><script>완결</script>",
            "<span class='b_million_class'>완결<img src='/promo.gif'></span>",
            "<img src='//images.novelpia.com/img/new/icon/silver_pencil.png' alt='완결'>",
            "<span>PLUS</span>",
        )));
        assert_eq!(page.status.as_deref(), Some("ongoing"));
    }

    #[test]
    fn requires_closed_main_title_writer_and_badge() {
        let title = "<div class='epnew-novel-title'>Book</div>";
        for rest in [
            "<div class='epnew-writer'><div><p class='in-writer'>Author</p><p class='in-badge'>PLUS</p></div>",
            "<div class='epnew-writer'><p class='in-writer'>Author</p><p class='in-badge'>PLUS</div>",
            "<section>Recommendations</section><div class='epnew-writer'><p class='in-writer'>Author</p><p class='in-badge'>PLUS</p></div>",
            "<div class='epnew-writer'><p class='in-writer'>작가명<a class='writer-name'></a></p><p class='in-badge'></p></div>",
        ] {
            let page = inspect_page(&format!("{title}{rest}"));
            assert_eq!(page.status.as_deref(), Some("unknown"), "{rest}");
            assert!(!page.status_reason.is_empty());
        }
    }

    #[test]
    fn reads_cover_markup_before_metadata_and_ignores_unpublished_fragments() {
        let page = inspect_page(concat!(
            r#"<meta property="og:image" content="https://novelpia.com/imagebox/cover/meta">"#,
            r#"<!-- <img class="cover_img" src="/imagebox/cover/comment"> -->"#,
            r#"<script>const x = '<img class="cover_img" src="/imagebox/cover/script">';</script>"#,
            r#"<a href="//image.novelpia.com/imagebox/cover/full#fragment"><img class="cover_img s_inv" src="/imagebox/cover/thumb?x=1&amp;y=2"></a>"#,
            r#"<div class="epnew-novel-title">소꿉친구와 <b>우결한다</b> &amp; &#x41;</div>"#,
        ));
        assert_eq!(page.title.as_deref(), Some("소꿉친구와 우결한다 & A"));
        let sources: Vec<_> = page
            .sources
            .iter()
            .map(|s| (s.kind.as_str(), s.url.as_str()))
            .collect();
        assert_eq!(
            sources,
            [
                ("original", "https://image.novelpia.com/imagebox/cover/full"),
                ("cover", "https://novelpia.com/imagebox/cover/thumb?x=1&y=2"),
            ]
        );
    }

    #[test]
    fn uses_open_graph_fallback_and_rejects_unrelated_links() {
        let page = inspect_page(concat!(
            r#"<meta content="노벨피아 - 웹소설로 꿈꾸는 세상! - My book" property="og:title">"#,
            r#"<meta property="og:image" content="//images.novelpia.com/imagebox/cover/thumb">"#,
            r#"<a href="https://images.novelpia.com.evil/imagebox/cover/original"><img src="/imagebox/cover/other"></a>"#,
        ));
        assert_eq!(page.title.as_deref(), Some("My book"));
        assert_eq!(page.sources.len(), 1);
        assert_eq!(
            page.sources[0].url,
            "https://images.novelpia.com/imagebox/cover/thumb"
        );
        assert!(inspect_page("<h1>Login</h1>").sources.is_empty());
    }

    #[test]
    fn unverified_titles_cannot_replace_a_saved_novel_title() {
        let login = r#"<meta property="og:title" content="Login"><h1>Login</h1>"#;
        assert!(inspect_page(login).title.is_none());
        let truncated = concat!(
            r#"<meta property="og:title" content="Possible fallback title">"#,
            r#"<meta property="og:image" content="/imagebox/cover/thumb">"#,
            r#"<div class="epnew-novel-title">Incomple"#,
        );
        assert!(inspect_page(truncated).title.is_none());
    }

    #[test]
    fn validates_novel_and_image_urls_by_host_and_path() {
        assert_eq!(
            parse_novel_url(" https://www.novelpia.com/novel/434103/?foo=bar#cover ").unwrap(),
            (
                "434103".to_owned(),
                "https://novelpia.com/novel/434103".to_owned(),
            )
        );
        for url in [
            "https://novelpia.com.evil/novel/1",
            "https://u:p@novelpia.com/novel/1",
            "https://novelpia.com/novel/../admin",
            "http://novelpia.com/novel/1",
            "https://novelpia.com:444/novel/1",
            "https://novelpia.com/novel/01",
            "https://images.novelpia.com/novel/1",
            "https://novelpia.com/novel/1/2",
        ] {
            assert!(parse_novel_url(url).is_err(), "{url}");
        }
        for url in [
            "https://images.novelpia.com.evil/imagebox/cover/x",
            "https://images.novelpia.com/img/logo.png",
            "https://images.novelpia.com:444/imagebox/cover/x",
            "https://u@images.novelpia.com/imagebox/cover/x",
            "file:///imagebox/cover/x",
            "/imagebox/cover/x/y",
        ] {
            assert!(parse_image_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn retains_korean_titles_and_removes_windows_path_separators() {
        assert_eq!(
            safe_folder("소꿉친구와 우결한다", "434103"),
            "소꿉친구와 우결한다 [434103]"
        );
        assert_eq!(safe_folder("../CON: x?*\\y.", "1"), "CON x y [1]");
        assert_eq!(safe_folder("... ", "1"), "Novelpia [1]");
    }

    #[test]
    fn enforces_stream_limit_even_without_a_content_length() {
        let mut good = &b"123"[..];
        let mut oversized = &b"1234"[..];
        assert_eq!(read_limited(&mut good, 3).unwrap(), b"123");
        assert!(read_limited(&mut oversized, 3)
            .unwrap_err()
            .to_string()
            .contains("размер"));
    }

    #[test]
    fn rate_limit_backoff_respects_seconds_date_and_bounds() {
        let now = chrono::DateTime::parse_from_rfc2822("Sun, 01 Nov 2026 12:00:00 GMT")
            .unwrap()
            .to_utc();
        assert_eq!(retry_after_ms(Some("120"), now), 120_000);
        assert_eq!(
            retry_after_ms(Some("Sun, 01 Nov 2026 12:02:00 GMT"), now),
            120_000
        );
        assert_eq!(
            retry_after_ms(Some("999999999999999999999999"), now),
            86_400_000
        );
        assert_eq!(retry_after_ms(Some("1"), now), 60_000);
        assert_eq!(retry_after_ms(None, now), 60_000);
    }
}
