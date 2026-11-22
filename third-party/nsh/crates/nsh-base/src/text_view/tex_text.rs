//! A formula's TeX as plain text, for a terminal: a terminal shows a
//! formula it has no renderer for as text a reader reads (`16.7 ms`,
//! `t_frame = 1000/60 ms`, `α ≤ √x`), never its source. The common
//! commands become their Unicode symbols, `\text{…}` and the font
//! commands their content, `\frac{a}{b}` `a/b`, spacing a space; a command
//! it does not know stays as written, its arguments read on.

/// `tex` as plain text.
pub(super) fn tex_text(tex: &str) -> String {
    let mut out = String::with_capacity(tex.len());
    Reader {
        chars: tex.chars().collect(),
        at: 0,
    }
    .group_until(None, &mut out);
    // Spacing commands and the source's own spaces leave runs of spaces.
    let mut text = String::with_capacity(out.len());
    for c in out.trim().chars() {
        if c == ' ' && text.ends_with(' ') {
            continue;
        }
        text.push(c);
    }
    text
}

struct Reader {
    chars: Vec<char>,
    at: usize,
}

impl Reader {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    /// Reads into `out` until `close` (or the end), consuming it.
    fn group_until(&mut self, close: Option<char>, out: &mut String) {
        while let Some(c) = self.peek() {
            self.at += 1;
            match c {
                _ if Some(c) == close => return,
                '{' => self.group_until(Some('}'), out),
                '\\' => self.command(out),
                '^' => self.script(out, true),
                '_' => self.script(out, false),
                '~' => out.push(' '),
                '&' => out.push(' '),
                '\n' | '\t' => out.push(' '),
                _ => out.push(c),
            }
        }
    }

    /// One argument: a `{…}` group or the next character (or command).
    fn argument(&mut self) -> String {
        let mut arg = String::new();
        while self.peek() == Some(' ') {
            self.at += 1;
        }
        match self.peek() {
            Some('{') => {
                self.at += 1;
                self.group_until(Some('}'), &mut arg);
            }
            Some('\\') => {
                self.at += 1;
                self.command(&mut arg);
            }
            Some(c) => {
                self.at += 1;
                arg.push(c);
            }
            None => {}
        }
        arg
    }

    /// A superscript or subscript: Unicode's script characters where the
    /// argument has them all, else `^` / `_` and the argument (in
    /// parentheses when it is more than one character).
    fn script(&mut self, out: &mut String, sup: bool) {
        let arg = self.argument();
        let mapped: Option<String> = arg
            .chars()
            .map(|c| if sup { superscript(c) } else { subscript(c) })
            .collect();
        match mapped {
            Some(s) if !s.is_empty() => out.push_str(&s),
            _ => {
                out.push(if sup { '^' } else { '_' });
                if arg.chars().count() > 1 && sup {
                    out.push('(');
                    out.push_str(&arg);
                    out.push(')');
                } else {
                    out.push_str(&arg);
                }
            }
        }
    }

    fn command(&mut self, out: &mut String) {
        let Some(first) = self.peek() else {
            out.push('\\');
            return;
        };
        if !first.is_ascii_alphabetic() {
            self.at += 1;
            match first {
                ',' | ';' | ':' | ' ' | '>' => out.push(' '),
                '!' => {}
                '\\' => out.push(' '),
                // `\{`, `\%`, `\$`, `\_`, `\&`, `\#`: the character.
                c => out.push(c),
            }
            return;
        }
        let start = self.at;
        while self.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
            self.at += 1;
        }
        let name: String = self.chars[start..self.at].iter().collect();
        match name.as_str() {
            "text" | "textrm" | "textit" | "textbf" | "mathrm" | "mathbf" | "mathit" | "mathsf"
            | "mathtt" | "mathcal" | "mathbb" | "mathfrak" | "operatorname" | "boldsymbol"
            | "bm" | "mbox" | "hbox" | "displaystyle" | "textstyle" => {
                if matches!(name.as_str(), "displaystyle" | "textstyle") {
                    return;
                }
                let arg = self.argument();
                out.push_str(&arg);
            }
            "frac" | "tfrac" | "dfrac" | "cfrac" => {
                let num = self.argument();
                let den = self.argument();
                push_operand(out, &num);
                out.push('/');
                push_operand(out, &den);
            }
            "sqrt" => {
                let arg = self.argument();
                out.push('√');
                push_operand(out, &arg);
            }
            "left" | "right" | "big" | "Big" | "bigg" | "Bigg" | "bigl" | "bigr" | "Bigl"
            | "Bigr" | "limits" | "nolimits" => {}
            "quad" | "qquad" | "enspace" | "thinspace" => out.push(' '),
            name => match symbol(name) {
                Some(s) => out.push_str(s),
                None => {
                    out.push('\\');
                    out.push_str(name);
                }
            },
        }
    }
}

/// `operand` after `/` or `√`, in parentheses when it is more than one
/// term.
fn push_operand(out: &mut String, operand: &str) {
    let operand = operand.trim();
    if operand.chars().any(|c| " +-−±=<>≤≥/".contains(c)) {
        out.push('(');
        out.push_str(operand);
        out.push(')');
    } else {
        out.push_str(operand);
    }
}

fn superscript(c: char) -> Option<char> {
    Some(match c {
        '0' => '⁰',
        '1' => '¹',
        '2' => '²',
        '3' => '³',
        '4' => '⁴',
        '5' => '⁵',
        '6' => '⁶',
        '7' => '⁷',
        '8' => '⁸',
        '9' => '⁹',
        '+' => '⁺',
        '-' | '−' => '⁻',
        '=' => '⁼',
        '(' => '⁽',
        ')' => '⁾',
        'n' => 'ⁿ',
        'i' => 'ⁱ',
        _ => return None,
    })
}

fn subscript(c: char) -> Option<char> {
    Some(match c {
        '0' => '₀',
        '1' => '₁',
        '2' => '₂',
        '3' => '₃',
        '4' => '₄',
        '5' => '₅',
        '6' => '₆',
        '7' => '₇',
        '8' => '₈',
        '9' => '₉',
        '+' => '₊',
        '-' | '−' => '₋',
        '=' => '₌',
        '(' => '₍',
        ')' => '₎',
        _ => return None,
    })
}

/// The Unicode symbol of TeX command `name`.
fn symbol(name: &str) -> Option<&'static str> {
    Some(match name {
        "alpha" => "α",
        "beta" => "β",
        "gamma" => "γ",
        "delta" => "δ",
        "epsilon" | "varepsilon" => "ε",
        "zeta" => "ζ",
        "eta" => "η",
        "theta" | "vartheta" => "θ",
        "iota" => "ι",
        "kappa" => "κ",
        "lambda" => "λ",
        "mu" => "μ",
        "nu" => "ν",
        "xi" => "ξ",
        "pi" => "π",
        "rho" => "ρ",
        "sigma" => "σ",
        "tau" => "τ",
        "upsilon" => "υ",
        "phi" | "varphi" => "φ",
        "chi" => "χ",
        "psi" => "ψ",
        "omega" => "ω",
        "Gamma" => "Γ",
        "Delta" => "Δ",
        "Theta" => "Θ",
        "Lambda" => "Λ",
        "Xi" => "Ξ",
        "Pi" => "Π",
        "Sigma" => "Σ",
        "Phi" => "Φ",
        "Psi" => "Ψ",
        "Omega" => "Ω",
        "times" => "×",
        "cdot" => "·",
        "div" => "÷",
        "pm" => "±",
        "mp" => "∓",
        "le" | "leq" => "≤",
        "ge" | "geq" => "≥",
        "ne" | "neq" => "≠",
        "approx" => "≈",
        "sim" => "∼",
        "equiv" => "≡",
        "propto" => "∝",
        "to" | "rightarrow" => "→",
        "leftarrow" => "←",
        "Rightarrow" | "implies" => "⇒",
        "Leftrightarrow" | "iff" => "⇔",
        "infty" => "∞",
        "sum" => "∑",
        "prod" => "∏",
        "int" => "∫",
        "partial" => "∂",
        "nabla" => "∇",
        "in" => "∈",
        "notin" => "∉",
        "subset" => "⊂",
        "subseteq" => "⊆",
        "cup" => "∪",
        "cap" => "∩",
        "forall" => "∀",
        "exists" => "∃",
        "emptyset" | "varnothing" => "∅",
        "degree" | "circ" => "°",
        "ldots" | "dots" | "cdots" => "…",
        "log" => "log",
        "ln" => "ln",
        "exp" => "exp",
        "sin" => "sin",
        "cos" => "cos",
        "tan" => "tan",
        "lim" => "lim",
        "max" => "max",
        "min" => "min",
        "lvert" | "rvert" | "vert" => "|",
        "langle" => "⟨",
        "rangle" => "⟩",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::tex_text;

    #[test]
    fn formulas_read_as_text() {
        assert_eq!(tex_text(r"16.7\,\text{ms}"), "16.7 ms");
        assert_eq!(
            tex_text(r"t_{\text{frame}} = \tfrac{1000}{60}\,\text{ms}"),
            "t_frame = 1000/60 ms"
        );
        assert_eq!(tex_text(r"x^2 + y_1 \le \sqrt{a+b}"), "x² + y₁ ≤ √(a+b)");
        assert_eq!(tex_text(r"\alpha \times \beta"), "α × β");
        assert_eq!(tex_text(r"e^{i\pi}"), "e^(iπ)");
    }
}
