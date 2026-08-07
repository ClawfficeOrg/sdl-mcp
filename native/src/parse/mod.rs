pub mod content_hash;
pub mod file_reader;

use std::panic;

use rayon::prelude::*;

use crate::extract;
use crate::lang;
use crate::types::{NativeContentInput, NativeFileInput, NativeParsedFile};

/// Stack size per Rayon worker thread (64 MiB). Tree-sitter's C-based parser
/// can recurse deeply on complex/generated files (e.g. LLVM's deeply-nested
/// C++ templates); the default stack may not suffice and cause a hard crash
/// (STATUS_STACK_BUFFER_OVERRUN on Windows). 64 MiB provides headroom for
/// both tree-sitter C recursion and the Rust AST walkers.
const RAYON_STACK_SIZE: usize = 64 * 1024 * 1024;

/// Maximum file size in bytes that the native parser will attempt to parse.
/// Files larger than this are skipped with a parse error. This prevents
/// pathological cases (e.g. 16 MB generated test files in LLVM) from
/// consuming excessive memory or triggering stack overflows in tree-sitter.
const MAX_PARSE_FILE_BYTES: usize = 1_500_000; // 1.5 MB

/// Parse and extract symbols/imports/calls from a batch of files in parallel.
///
/// Uses Rayon's work-stealing thread pool. Each thread gets its own
/// thread-local tree-sitter parser instance.
///
/// Individual file panics (e.g. tree-sitter C-level crashes) are caught via
/// `catch_unwind` so they produce a per-file `parse_error` instead of
/// bringing down the entire Node.js process.
pub fn parse_files_parallel(
    files: &[NativeFileInput],
    thread_count: usize,
) -> Vec<NativeParsedFile> {
    // Build a custom thread pool with large stacks. If both the custom pool
    // and global pool fail to build (e.g. OOM under heavy load), we fall back
    // to single-threaded sequential parsing rather than panicking.
    let pool = match rayon::ThreadPoolBuilder::new()
        .num_threads(thread_count)
        .stack_size(RAYON_STACK_SIZE)
        .build()
    {
        Ok(pool) => pool,
        Err(e1) => match rayon::ThreadPoolBuilder::new().build() {
            Ok(pool) => {
                eprintln!("sdl-mcp-native: custom Rayon pool failed ({e1}), using global pool");
                pool
            }
            Err(e2) => {
                eprintln!(
                    "sdl-mcp-native: all Rayon pools failed ({e1}, {e2}), parsing sequentially"
                );
                // Sequential fallback — no parallelism but no crash
                return files.iter().map(parse_single_file).collect();
            }
        },
    };

    pool.install(|| files.par_iter().map(parse_single_file).collect())
}

/// Parse a single file: read content, compute hash, parse AST, extract all.
fn parse_single_file(input: &NativeFileInput) -> NativeParsedFile {
    let content = match file_reader::read_file(&input.absolute_path) {
        Ok(c) => c,
        Err(e) => {
            return NativeParsedFile {
                rel_path: input.rel_path.clone(),
                content_hash: String::new(),
                content: None,
                symbols: vec![],
                imports: vec![],
                calls: vec![],
                parse_error: Some(format!("{e}")),
            };
        }
    };

    parse_source_safe(NativeContentInput {
        repo_id: input.repo_id.clone(),
        rel_path: input.rel_path.clone(),
        language: input.language.clone(),
        content,
    })
}

pub(crate) fn parse_content_value(input: NativeContentInput) -> NativeParsedFile {
    parse_source_safe(input)
}

fn parse_source_safe(input: NativeContentInput) -> NativeParsedFile {
    parse_source_safe_with(input, parse_source_unchecked)
}

fn parse_source_safe_with<F>(input: NativeContentInput, parse_impl: F) -> NativeParsedFile
where
    F: FnOnce(NativeContentInput, String) -> NativeParsedFile,
{
    let rel_path = input.rel_path.clone();

    match panic::catch_unwind(panic::AssertUnwindSafe(|| {
        let content_hash = content_hash::hash_content(&input.content);
        parse_impl(input, content_hash)
    })) {
        Ok(result) => result,
        Err(payload) => {
            let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                format!("panic during parse: {s}")
            } else if let Some(s) = payload.downcast_ref::<String>() {
                format!("panic during parse: {s}")
            } else {
                "panic during parse: unknown payload".to_string()
            };
            NativeParsedFile {
                rel_path,
                content_hash: String::new(),
                content: None,
                symbols: vec![],
                imports: vec![],
                calls: vec![],
                parse_error: Some(msg),
            }
        }
    }
}

fn parse_source_unchecked(input: NativeContentInput, content_hash: String) -> NativeParsedFile {
    let content = input.content;

    if lang::get_language(&input.language).is_none() {
        return NativeParsedFile {
            rel_path: input.rel_path,
            content_hash,
            content: None,
            symbols: vec![],
            imports: vec![],
            calls: vec![],
            parse_error: Some(format!("Unsupported language: {}", input.language)),
        };
    }

    // Skip files that are too large — they cause excessive memory usage and
    // risk stack overflows in tree-sitter's C parser on deeply-nested ASTs.
    if content.len() > MAX_PARSE_FILE_BYTES {
        return NativeParsedFile {
            rel_path: input.rel_path,
            content_hash,
            content: None,
            symbols: vec![],
            imports: vec![],
            calls: vec![],
            parse_error: Some(format!(
                "File too large for native parser ({} bytes, limit {})",
                content.len(),
                MAX_PARSE_FILE_BYTES
            )),
        };
    }

    let mut parser = lang::create_parser(&input.language);
    let tree = match parser.as_mut().and_then(|p| p.parse(&content, None)) {
        Some(t) => t,
        None => {
            return NativeParsedFile {
                rel_path: input.rel_path,
                content_hash,
                content: None,
                symbols: vec![],
                imports: vec![],
                calls: vec![],
                parse_error: Some("tree-sitter parse returned None".into()),
            };
        }
    };

    let root = tree.root_node();

    // Extract symbols
    let mut symbols = extract::symbols::extract_symbols(
        root,
        content.as_bytes(),
        &input.repo_id,
        &input.rel_path,
        &input.language,
    );

    for symbol in &mut symbols {
        symbol.summary = extract::summary::generate_summary(symbol, &content, &input.language);

        // Compute summary quality score
        symbol.summary_quality = if !symbol.summary.is_empty() {
            // Check if summary came from a doc comment by re-extracting
            // (doc comment summaries tend to be longer and don't match auto-gen patterns)
            let has_doc_comment =
                extract::summary::has_doc_comment(symbol, &content, &input.language);
            if has_doc_comment {
                Some(1.0)
            } else if matches!(symbol.kind.as_str(), "function" | "method" | "constructor") {
                Some(0.4)
            } else {
                Some(0.3)
            }
        } else {
            Some(0.0)
        };

        let invariants = extract::invariants::extract_invariants(symbol, &content);
        symbol.invariants = invariants;

        let side_effects = extract::side_effects::extract_side_effects(symbol, &content);
        symbol.side_effects = side_effects;

        let role_tags = extract::roles::extract_role_tags(symbol, &input.rel_path);
        symbol.role_tags = role_tags.clone();
        symbol.search_text =
            extract::search_text::build_search_text(symbol, &input.rel_path, &role_tags);
    }

    // Extract imports
    let imports = extract::imports::extract_imports(root, content.as_bytes(), &input.language);

    // Extract calls
    let calls = extract::calls::extract_calls(root, content.as_bytes(), &symbols, &input.language);

    NativeParsedFile {
        rel_path: input.rel_path,
        content_hash,
        content: Some(content),
        symbols,
        imports,
        calls,
        parse_error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn parse_disk_fixture(source: &str, language: &str) -> NativeParsedFile {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX_EPOCH")
            .as_nanos();
        let fixture_dir =
            std::env::temp_dir().join(format!("sdl_mcp_parse_{}_{}", std::process::id(), unique));
        let file_path = fixture_dir.join("fixture.mjs");
        fs::create_dir(&fixture_dir).expect("failed to create temporary fixture directory");
        fs::write(&file_path, source).expect("failed to write temporary fixture");

        let parsed = parse_single_file(&NativeFileInput {
            rel_path: "fixture.mjs".to_string(),
            absolute_path: file_path.to_string_lossy().into_owned(),
            repo_id: "test-repo".to_string(),
            language: language.to_string(),
        });

        fs::remove_file(&file_path).expect("failed to remove temporary fixture");
        let _ = fs::remove_dir(fixture_dir);
        parsed
    }

    fn canonical_range(range: &crate::types::NativeRange) -> Value {
        json!({
            "startLine": range.start_line,
            "startCol": range.start_col,
            "endLine": range.end_line,
            "endCol": range.end_col,
        })
    }

    fn canonical_native_file(file: &NativeParsedFile) -> Value {
        json!({
            "relPath": file.rel_path,
            "contentHash": file.content_hash,
            "content": file.content,
            "symbols": file.symbols.iter().map(|symbol| json!({
                "nodeId": symbol.node_id,
                "symbolId": symbol.symbol_id,
                "astFingerprint": symbol.ast_fingerprint,
                "kind": symbol.kind,
                "name": symbol.name,
                "exported": symbol.exported,
                "visibility": symbol.visibility,
                "range": canonical_range(&symbol.range),
                "signature": symbol.signature.as_ref().map(|signature| json!({
                    "params": signature.params.as_ref().map(|params| params.iter().map(|param| json!({
                        "name": param.name,
                        "typeName": param.type_name,
                    })).collect::<Vec<_>>()),
                    "returns": signature.returns,
                    "generics": signature.generics,
                })),
                "summary": symbol.summary,
                "invariants": symbol.invariants,
                "sideEffects": symbol.side_effects,
                "roleTags": symbol.role_tags,
                "decorators": symbol.decorators,
                "searchText": symbol.search_text,
                "summaryQuality": symbol.summary_quality,
            })).collect::<Vec<_>>(),
            "imports": file.imports.iter().map(|import| json!({
                "specifier": import.specifier,
                "isRelative": import.is_relative,
                "isExternal": import.is_external,
                "namedImports": import.named_imports,
                "defaultImport": import.default_import,
                "namespaceImport": import.namespace_import,
                "isReExport": import.is_re_export,
                "range": canonical_range(&import.range),
            })).collect::<Vec<_>>(),
            "calls": file.calls.iter().map(|call| json!({
                "callerNodeId": call.caller_node_id,
                "calleeIdentifier": call.callee_identifier,
                "callType": call.call_type,
                "range": canonical_range(&call.range),
            })).collect::<Vec<_>>(),
            "parseError": file.parse_error,
        })
    }

    fn content_input(source: &str, language: &str) -> NativeContentInput {
        NativeContentInput {
            repo_id: "test-repo".to_string(),
            rel_path: "fixture.mjs".to_string(),
            language: language.to_string(),
            content: source.to_string(),
        }
    }

    #[test]
    fn parse_content_matches_disk_parse() {
        let source = r#"import value from "./value.js";
export function double(input) { return value(input) * 2; }
"#;

        let disk = parse_disk_fixture(source, "js");
        let in_memory = parse_content_value(content_input(source, "js"));

        assert!(disk.parse_error.is_none());
        assert_eq!(
            canonical_native_file(&in_memory),
            canonical_native_file(&disk)
        );
    }

    #[test]
    fn parse_content_reports_same_unsupported_language_error_as_disk_parse() {
        let source = "plain text";

        let disk = parse_disk_fixture(source, "unsupported-language");
        let in_memory = parse_content_value(content_input(source, "unsupported-language"));

        assert_eq!(in_memory.parse_error, disk.parse_error);
    }

    #[test]
    fn parse_content_rejects_oversized_source() {
        let source = "x".repeat(MAX_PARSE_FILE_BYTES + 1);
        let expected_error = format!(
            "File too large for native parser ({} bytes, limit {})",
            source.len(),
            MAX_PARSE_FILE_BYTES
        );

        let parsed = parse_content_value(content_input(&source, "js"));

        assert_eq!(parsed.parse_error.as_deref(), Some(expected_error.as_str()));
    }

    #[test]
    fn parse_content_converts_panics_to_parse_errors() {
        let input = content_input("export const value = 1;", "js");

        let parsed = parse_source_safe_with(input, |_, _| panic!("fixture panic"));

        assert_eq!(
            parsed.parse_error.as_deref(),
            Some("panic during parse: fixture panic")
        );
    }

    #[test]
    fn go_parser_emits_symbols_for_valid_file() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX_EPOCH")
            .as_nanos();
        let file_path = std::env::temp_dir().join(format!("sdl_mcp_parse_{unique}.go"));
        let source = r#"package main

import "fmt"

func main() { fmt.Println(add(1, 2)) }

func add(a int, b int) int { return a + b }
"#;

        fs::write(&file_path, source).expect("failed to write temporary Go file");

        let input = NativeFileInput {
            rel_path: "tmp/smoke.go".to_string(),
            absolute_path: file_path.to_string_lossy().into_owned(),
            repo_id: "test-repo".to_string(),
            language: "go".to_string(),
        };

        let parsed = parse_single_file(&input);
        let _ = fs::remove_file(file_path);

        assert_eq!(parsed.parse_error.as_deref(), None);
        assert!(
            parsed.symbols.iter().any(|symbol| symbol.name == "main"),
            "expected Go parser to emit main symbol, got {:?}",
            parsed.symbols
        );
        assert!(
            parsed.symbols.iter().any(|symbol| symbol.name == "add"),
            "expected Go parser to emit add symbol, got {:?}",
            parsed.symbols
        );
    }

    #[test]
    fn oversized_unsupported_language_reports_unsupported_language() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX_EPOCH")
            .as_nanos();
        let file_path = std::env::temp_dir().join(format!("sdl_mcp_parse_{unique}.txt"));
        let large_content = vec![b'x'; MAX_PARSE_FILE_BYTES + 1];

        fs::write(&file_path, large_content).expect("failed to write temporary file");

        let input = NativeFileInput {
            rel_path: "tmp/oversized.unsupported".to_string(),
            absolute_path: file_path.to_string_lossy().into_owned(),
            repo_id: "test-repo".to_string(),
            language: "unsupported-language".to_string(),
        };

        let parsed = parse_single_file(&input);
        let _ = fs::remove_file(file_path);

        assert_eq!(
            parsed.parse_error.as_deref(),
            Some("Unsupported language: unsupported-language")
        );
    }
}
