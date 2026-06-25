import type { InteractiveElement, PageContent } from "../../shared/types";
import {
  getUrlPathSegments,
  normalizeComparable,
  normalizeUrlForMatch,
} from "./url-normalization";

interface SiteResultFilter {
  /** Hostname (without www) this filter applies to. */
  hostname: string;
  /** Paths that should always be treated as listing/result pages. */
  listingPaths?: string[];
  /** Pathnames whose links are never considered result candidates. */
  utilityPathnames?: string[];
  /** Link texts that are never considered result candidates. */
  utilityTextPatterns?: RegExp[];
}

const SITE_RESULT_FILTERS: SiteResultFilter[] = [
  {
    hostname: "news.ycombinator.com",
    listingPaths: [
      "/",
      "/news",
      "/newest",
      "/front",
      "/ask",
      "/show",
      "/jobs",
      "/best",
      "/active",
      "/classic",
      "/noobstories",
    ],
    utilityPathnames: ["/hide", "/user"],
    utilityTextPatterns: [
      /^(hide|past|favorite|unfavorite|flag|unflag|discuss|reply|parent|more)$/,
      /^\d+\s+(?:comments?|points?)$/,
    ],
  },
];

function matchesSiteFilter(url: string, filter: SiteResultFilter, baseHostname: string): boolean {
  try {
    const parsed = new URL(url, baseHostname ? `https://${baseHostname}` : undefined);
    return parsed.hostname === filter.hostname;
  } catch {
    return false;
  }
}

export function isSiteListingPage(url: string): boolean {
  for (const filter of SITE_RESULT_FILTERS) {
    if (!matchesSiteFilter(url, filter, "")) continue;
    try {
      const pathname = new URL(url).pathname.replace(/\/+$/, "") || "/";
      if (filter.listingPaths?.includes(pathname)) return true;
    } catch {
      // ignore malformed URLs
    }
  }
  return false;
}

function isSiteUtilityLink(element: InteractiveElement): boolean {
  if (!element.href) return false;

  for (const filter of SITE_RESULT_FILTERS) {
    if (!matchesSiteFilter(element.href, filter, "")) continue;

    const text = normalizeComparable(element.text || "");
    for (const pattern of filter.utilityTextPatterns ?? []) {
      if (pattern.test(text)) return true;
    }

    try {
      const pathname = new URL(element.href).pathname.replace(/\/+$/, "") || "/";
      if (filter.utilityPathnames?.includes(pathname)) return true;
    } catch {
      // ignore malformed URLs
    }
  }

  return false;
}

export function isSearchOrListingPage(page: PageContent): boolean {
  if (isSiteListingPage(page.url)) return true;

  const haystack = normalizeComparable(
    [page.url, page.title, page.excerpt, page.headings.map((heading) => heading.text).join(" ")]
      .filter(Boolean)
      .join(" "),
  );

  return /\b(search|results|find|discover|browse|repositories|repository|issues|pull requests|prs|users|events|listings)\b/.test(
    haystack,
  );
}

function collectJsonLdEntityItems(
  input: unknown,
  results: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (!input) return results;

  if (Array.isArray(input)) {
    input.forEach((item) => collectJsonLdEntityItems(item, results));
    return results;
  }

  if (typeof input !== "object") return results;

  const item = input as Record<string, unknown>;
  const type = item["@type"];
  const types = Array.isArray(type) ? type : [type];
  const typeNames = types.filter((entry): entry is string => typeof entry === "string");

  if (
    (typeof item.name === "string" || typeof item.url === "string") &&
    !typeNames.some((entry) =>
      ["BreadcrumbList", "Organization", "WebSite", "WebPage"].includes(entry),
    )
  ) {
    results.push(item);
  }

  collectJsonLdEntityItems(item["@graph"], results);
  collectJsonLdEntityItems(item.mainEntity, results);
  collectJsonLdEntityItems(item.itemListElement, results);
  collectJsonLdEntityItems(item.item, results);

  return results;
}

export function getResultCandidates(page: PageContent): InteractiveElement[] {
  const entityItems = collectJsonLdEntityItems(page.jsonLd ?? []);
  const entityNames = new Set(
    entityItems
      .map((item) => (typeof item.name === "string" ? normalizeComparable(item.name) : ""))
      .filter(Boolean),
  );
  const entityUrls = new Set(
    entityItems
      .map((item) => (typeof item.url === "string" ? normalizeUrlForMatch(item.url) : null))
      .filter((value): value is string => Boolean(value)),
  );

  const pageHost = normalizeUrlForMatch(page.url);
  const searchOrListingPage = isSearchOrListingPage(page);

  const scored = page.interactiveElements
    .filter(
      (element) =>
        element.type === "link" &&
        element.text?.trim() &&
        element.href &&
        !isSiteUtilityLink(element),
    )
    .map((element) => {
      const text = element.text?.trim() || "";
      const comparableText = normalizeComparable(text);
      const href = normalizeUrlForMatch(element.href);
      const haystack = normalizeComparable(
        [element.text, element.description, element.selector, element.href]
          .filter(Boolean)
          .join(" "),
      );

      let score = 0;

      if (entityNames.has(comparableText)) score += 6;
      if (href && entityUrls.has(href)) score += 6;
      if (
        entityItems.some((item) => {
          const name = typeof item.name === "string" ? normalizeComparable(item.name) : "";
          return Boolean(name) && (name.includes(comparableText) || comparableText.includes(name));
        })
      ) {
        score += 4;
      }

      if (element.context === "article") score += 3;
      else if (element.context === "main" || element.context === "content") score += 1;

      if (href && pageHost) {
        try {
          if (new URL(href).origin === new URL(pageHost).origin) score += 1;
        } catch {
          // ignore malformed URLs
        }
      }

      const hrefSegments = getUrlPathSegments(element.href);
      if (hrefSegments.length >= 2) score += 1;
      if (text.includes("/")) score += 1;

      if (
        searchOrListingPage &&
        (element.context === "article" ||
          element.context === "main" ||
          element.context === "content")
      ) {
        score += 2;
      }

      if (/\b(card|tile|result|rating|review)\b/.test(haystack)) score += 1;
      if (/\b(item|list|row|repo|repository|issue|pull request|event)\b/.test(haystack)) {
        score += 1;
      }
      if (text.length >= 12 && text.split(/\s+/).length >= 2) score += 1;

      if (
        element.context === "nav" ||
        element.context === "header" ||
        element.context === "footer" ||
        element.context === "sidebar" ||
        element.context === "dialog"
      ) {
        score -= 5;
      }

      if (
        /\b(home|menu|about|contact|privacy|terms|login|sign in|sign up|subscribe|newsletter|facebook|instagram|pinterest|share|print|next|previous|prev|sort|filter|star|sponsor)\b/.test(
          comparableText,
        )
      ) {
        score -= 4;
      }

      return { element, score };
    })
    .filter(({ score, element }) => {
      if (entityItems.length > 0) return score >= 4;
      if (searchOrListingPage) {
        return (
          score >= 4 ||
          (score >= 3 &&
            (element.context === "article" ||
              element.context === "main" ||
              element.context === "content"))
        );
      }
      return score >= 4 || (score >= 3 && element.context === "article");
    })
    .sort((a, b) => b.score - a.score || (a.element.index ?? 0) - (b.element.index ?? 0));

  const seen = new Set<string>();
  return scored
    .map(({ element }) => element)
    .filter((element) => {
      const key = `${normalizeComparable(element.text || "")}|${normalizeUrlForMatch(element.href) || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
