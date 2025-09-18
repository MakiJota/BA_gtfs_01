library(gtfstools)
library(ggplot2)
library(dplyr)
library(stringr)

path <- file.path("C:/Users/edgardo/Documents/GitHub/BA_gtfs_01/assets/SDC", "gtfs.zip")

gtfs_CITY <- read_gtfs(path)


gtfs_CITY

metro <-  filter_by_agency_id(gtfs_CITY, "M", keep = TRUE)
metro
metro$shapes

unique(metro$shapes$shape_id)

metro$shapes <- metro$shapes %>%
  mutate(line_id = sapply(shape_id, function(x) {
    # Remove direction (-R or -I)
    base <- strsplit(x, "-")[[1]][1]
    
    # Keep full name if it ends with A (like L4A)
    if (grepl("A$", base)) {
      return(base)
    } else {
      # Otherwise, keep only the numeric part and L letter
      return(substr(base, 1, 2))
    }
  }))
unique(metro$shapes$shape_id)

metro$stops
metro$stops$stop_id  
metro$stops$stop_code           

#metro$stops$line_id <- sub("-.*", "", metro$stops$stop_id)

unique(metro$stops$line_id )


stop_route <- metro$stop_times %>%
  left_join(metro$trips, by = "trip_id") %>%  # add route_id to each stop_time
  left_join(metro$routes, by = "route_id") %>%  # add route info
  left_join(metro$stops, by = "stop_id")       # add stop info


stop_lines <- stop_route %>%
  group_by(stop_id, stop_name) %>%
  summarise(lines = paste(unique(route_short_name), collapse = ", "), .groups = "drop")

unique(stop_lines$lines)


stop_lines_first <- stop_lines %>%
  mutate(first_line = sapply(lines, function(x) {
    # Split by comma and take the first part
    first <- str_trim(unlist(strsplit(x, ",\\s*"))[1])
    
    # Simplify: keep everything before the first dash,
    # but if it ends with a letter (like L4A), keep the full name
    if (grepl("-", first)) {
      simplified <- unlist(strsplit(first, "-"))[1]
    } else {
      simplified <- first
    }
    
    simplified
  }))

# View unique first lines
unique(stop_lines_first$first_line)

metro$stops <- metro$stops %>%
  left_join(stop_lines_first[,c('stop_id', 'first_line')], by = 'stop_id') %>%
  rename(line_id = first_line)




write_gtfs(
  metro,
  "./assets/SDC/GTFS/metro.zip",
  files = NULL,
  standard_only = FALSE,
  as_dir = FALSE,
  overwrite = TRUE,
  quiet = TRUE
)

