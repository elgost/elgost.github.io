#!/usr/bin/env python3
"""
Convert a Gramps XML (.gramps) export to the JSON format used by the family-tree web app.

This version handles:
- Gramps XML namespaces
- Person handles vs. public Gramps IDs
- Family relationships
- <childref> elements
- Birth/death events
- Date values/ranges/spans
- Basic place lookup
"""

import argparse
import json
import xml.etree.ElementTree as ET
from pathlib import Path


def tag(name):
    """
    Return an ElementTree wildcard tag that matches a tag
    regardless of the Gramps XML namespace version.
    """
    return f"{{*}}{name}"


def child_text(element, name, default=""):
    """
    Return the text content of a direct child element.
    """
    if element is None:
        return default

    node = element.find(tag(name))

    if node is None or node.text is None:
        return default

    return node.text.strip()


def event_date(event):
    """
    Extract a readable date from a Gramps event.

    Handles:
    - <dateval val="...">
    - <daterange start="..." stop="...">
    - <datespan start="..." stop="...">
    """

    if event is None:
        return ""

    dateval = event.find(tag("dateval"))

    if dateval is not None:
        value = dateval.get("val", "").strip()

        if value:
            return value

    daterange = event.find(tag("daterange"))

    if daterange is not None:
        start = daterange.get("start", "").strip()
        stop = daterange.get("stop", "").strip()

        if start and stop:
            return f"{start}–{stop}"

        return start or stop

    datespan = event.find(tag("datespan"))

    if datespan is not None:
        start = datespan.get("start", "").strip()
        stop = datespan.get("stop", "").strip()

        if start and stop:
            return f"{start}–{stop}"

        return start or stop

    return ""


def event_place(event, places_by_handle):
    """
    Resolve an event's place reference to the place name.
    """

    if event is None:
        return ""

    place_ref = event.find(tag("place"))

    if place_ref is None:
        return ""

    place_handle = place_ref.get("hlink")

    if not place_handle:
        return ""

    return places_by_handle.get(place_handle, "")


def main():
    parser = argparse.ArgumentParser(
        description="Convert a Gramps .gramps XML export to family-tree.json"
    )

    parser.add_argument(
        "input",
        help="Input Gramps XML file, for example data.gramps",
    )

    parser.add_argument(
        "-o",
        "--output",
        default="data/family-tree.json",
        help="Output JSON file (default: data/family-tree.json)",
    )

    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        raise SystemExit(
            f"Input file not found: {input_path}"
        )

    try:
        root = ET.parse(input_path).getroot()

    except ET.ParseError as exc:
        raise SystemExit(
            f"Could not parse {input_path} as XML: {exc}"
        ) from exc

    #
    # Build place lookup
    #
    # Gramps references places using internal "handle" values.
    #
    places_by_handle = {}

    for place in root.findall(f".//{tag('placeobj')}"):

        handle = place.get("handle")

        if not handle:
            continue

        place_name = ""

        pname = place.find(tag("pname"))

        if pname is not None:
            place_name = pname.get("value", "").strip()

        places_by_handle[handle] = place_name

    #
    # Build event lookup
    #
    # Person event references point at event handles rather
    # than the event's visible Gramps ID.
    #
    events_by_handle = {}

    for event in root.findall(f".//{tag('event')}"):

        handle = event.get("handle")

        if handle:
            events_by_handle[handle] = event

    #
    # Parse people
    #
    # We also create a handle -> Gramps ID lookup because
    # families reference people using internal handles.
    #
    people = []
    people_by_handle = {}

    for person in root.findall(f".//{tag('person')}"):

        person_id = person.get("id")
        person_handle = person.get("handle")

        if not person_id or not person_handle:
            continue

        #
        # Name
        #
        name = person.find(tag("name"))

        given_name = child_text(name, "first")
        surname = child_text(name, "surname")
        nickname = child_text(name, "nick")

        full_name = " ".join(
            part
            for part in (given_name, surname)
            if part
        ).strip()

        if not full_name:
            full_name = nickname or "Unknown"

        #
        # Basic person record
        #
        record = {
            "id": person_id,
            "name": full_name,
            "givenName": given_name,
            "surname": surname,
            "gender": child_text(person, "gender"),
            "birth": "",
            "birthPlace": "",
            "death": "",
            "deathPlace": "",
        }

        #
        # Resolve event references
        #
        for event_ref in person.findall(tag("eventref")):

            event_handle = event_ref.get("hlink")

            if not event_handle:
                continue

            event = events_by_handle.get(event_handle)

            if event is None:
                continue

            event_type = child_text(
                event,
                "type",
            ).lower()

            date = event_date(event)

            place = event_place(
                event,
                places_by_handle,
            )

            if event_type == "birth":

                record["birth"] = date
                record["birthPlace"] = place

            elif event_type == "death":

                record["death"] = date
                record["deathPlace"] = place

        people.append(record)

        #
        # Important:
        #
        # Families refer to people by handle,
        # while the website uses the public Gramps ID.
        #
        people_by_handle[person_handle] = person_id

    #
    # Parse families
    #
    families = []

    for family in root.findall(f".//{tag('family')}"):

        family_id = family.get("id")

        if not family_id:
            continue

        #
        # Parents
        #
        father = family.find(tag("father"))
        mother = family.find(tag("mother"))

        father_handle = (
            father.get("hlink")
            if father is not None
            else None
        )

        mother_handle = (
            mother.get("hlink")
            if mother is not None
            else None
        )

        #
        # Children
        #
        # Gramps XML uses <childref>, not <child>.
        #
        children = []

        for child_ref in family.findall(tag("childref")):

            child_handle = child_ref.get("hlink")

            if not child_handle:
                continue

            child_id = people_by_handle.get(
                child_handle
            )

            if child_id:
                children.append(child_id)

        family_record = {
            "id": family_id,
            "father": people_by_handle.get(
                father_handle
            ),
            "mother": people_by_handle.get(
                mother_handle
            ),
            "children": children,
        }

        families.append(family_record)

    #
    # Build output structure
    #
    output = {
        "people": people,
        "families": families,
    }

    #
    # Write JSON
    #
    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    output_path.write_text(
        json.dumps(
            output,
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"Input:    {input_path}")
    print(f"People:   {len(people)}")
    print(f"Families: {len(families)}")
    print(f"Output:   {output_path}")


if __name__ == "__main__":
    main()