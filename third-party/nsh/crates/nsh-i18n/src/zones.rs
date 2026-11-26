//! Named time zones an app ships (`nsh.json` `timeZones`): the rules of
//! each, from the IANA Time Zone Database the toolchain carries
//! (`jiff-tzdb`), as the runtime reads them (`Intl.DateTimeFormat`'s
//! `timeZone`).
//!
//! A zone is written as JSON:
//!
//! ```json
//! {
//!   "name": "America/New_York",
//!   "types": [[-17762, "LMT"], [-18000, "EST"], [-14400, "EDT"]],
//!   "transitions": [[-2717650800, 1], [-1633280400, 2]],
//!   "rule": "EST5EDT,M3.2.0,M11.1.0"
//! }
//! ```
//!
//! `types` are offsets (seconds east of UTC) and their abbreviations;
//! `transitions` the times (seconds since the epoch) from which a type
//! applies; `rule` the POSIX TZ string after the last transition (TZif's
//! footer), absent where there is none.

use serde_json::{Value, json};

/// The data of the zone `name` (any case; a link such as `US/Eastern`
/// too), or why there is none.
pub fn zone_data(name: &str) -> Result<Value, String> {
    let (canonical, tzif) = jiff_tzdb::get(name)
        .ok_or_else(|| format!("timeZones: `{name}` is not a time zone of the IANA database"))?;
    let zone = parse_tzif(tzif).map_err(|e| format!("timeZones: `{canonical}`: {e}"))?;
    Ok(json!({
        "name": canonical,
        "types": zone.types.iter().map(|(offset, abbr)| json!([offset, abbr])).collect::<Vec<_>>(),
        "transitions": zone.transitions.iter().map(|(at, ty)| json!([at, ty])).collect::<Vec<_>>(),
        "rule": zone.rule,
    }))
}

struct Tzif {
    types: Vec<(i32, String)>,
    transitions: Vec<(i64, u8)>,
    rule: Option<String>,
}

/// Reads TZif (RFC 8536), version 2 or later: the 64-bit data and footer.
fn parse_tzif(data: &[u8]) -> Result<Tzif, String> {
    struct Header {
        isutcnt: usize,
        isstdcnt: usize,
        leapcnt: usize,
        timecnt: usize,
        typecnt: usize,
        charcnt: usize,
    }
    fn header(data: &[u8]) -> Result<(u8, Header), String> {
        if data.len() < 44 || &data[..4] != b"TZif" {
            return Err("not TZif data".into());
        }
        let count = |i: usize| {
            u32::from_be_bytes(data[20 + 4 * i..24 + 4 * i].try_into().unwrap()) as usize
        };
        Ok((
            data[4],
            Header {
                isutcnt: count(0),
                isstdcnt: count(1),
                leapcnt: count(2),
                timecnt: count(3),
                typecnt: count(4),
                charcnt: count(5),
            },
        ))
    }
    fn len(h: &Header, time: usize) -> usize {
        h.timecnt * time
            + h.timecnt
            + h.typecnt * 6
            + h.charcnt
            + h.leapcnt * (time + 4)
            + h.isstdcnt
            + h.isutcnt
    }
    let (version, v1) = header(data)?;
    if version < b'2' {
        return Err("TZif version 1 has no 64-bit data".into());
    }
    let data = &data[44 + len(&v1, 4)..];
    let (_, h) = header(data)?;
    let body = data.get(44..44 + len(&h, 8)).ok_or("truncated TZif data")?;
    let (times, rest) = body.split_at(h.timecnt * 8);
    let (indices, rest) = rest.split_at(h.timecnt);
    let (infos, rest) = rest.split_at(h.typecnt * 6);
    let chars = &rest[..h.charcnt];
    let abbr = |at: usize| {
        let tail = chars.get(at..).unwrap_or_default();
        let end = tail.iter().position(|b| *b == 0).unwrap_or(tail.len());
        String::from_utf8_lossy(&tail[..end]).into_owned()
    };
    let types = infos
        .as_chunks::<6>()
        .0
        .iter()
        .map(|info| {
            let offset = i32::from_be_bytes(info[..4].try_into().unwrap());
            (offset, abbr(info[5] as usize))
        })
        .collect::<Vec<_>>();
    let transitions = times
        .as_chunks::<8>()
        .0
        .iter()
        .zip(indices)
        .map(|(at, ty)| (i64::from_be_bytes(*at), *ty))
        .collect::<Vec<_>>();
    if transitions
        .iter()
        .any(|(_, ty)| *ty as usize >= types.len())
        || types.is_empty()
    {
        return Err("a transition to a type it does not have".into());
    }
    let footer = &data[44 + len(&h, 8)..];
    let rule = footer
        .strip_prefix(b"\n")
        .and_then(|f| f.split(|b| *b == b'\n').next())
        .map(|r| String::from_utf8_lossy(r).into_owned())
        .filter(|r| !r.is_empty());
    Ok(Tzif {
        types,
        transitions,
        rule,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zones_are_read_from_the_database() {
        let ny = zone_data("america/new_york").unwrap();
        assert_eq!(ny["name"], "America/New_York");
        assert_eq!(ny["rule"], "EST5EDT,M3.2.0,M11.1.0");
        let types = ny["types"].as_array().unwrap();
        assert!(types.contains(&json!([-18000, "EST"])));
        assert!(types.contains(&json!([-14400, "EDT"])));
        assert!(!ny["transitions"].as_array().unwrap().is_empty());
        let eastern = zone_data("US/Eastern").unwrap();
        assert_eq!(eastern["transitions"], ny["transitions"]);
        assert_eq!(zone_data("Asia/Kolkata").unwrap()["rule"], "IST-5:30");
        assert_eq!(
            zone_data("Australia/Lord_Howe").unwrap()["rule"],
            "<+1030>-10:30<+11>-11,M10.1.0,M4.1.0"
        );
        assert!(zone_data("Mars/Olympus_Mons").is_err());
    }
}
