library(gtfstools)
library(ggplot2)

# 
# data_path <- system.file("extdata", package = "gtfstools")
# 
# 
# ber_path <- file.path(data_path, "ber_gtfs.zip")
# 
# 
# BER_gtfs <- read_gtfs(ber_path)
# # 
# # 
# # S_BAHN <- filter_by_agency_id(BER_gtfs, "1", keep = TRUE)
# 
# 
# write_gtfs(
#   BER_gtfs,
#   "./assets/BE/GTFS/be.zip",
#   files = NULL,
#   standard_only = FALSE,
#   as_dir = FALSE,
#   overwrite = TRUE,
#   quiet = TRUE
# )
# 
# 



path <- file.path("./assets/CDMX/GTFS_ALL/", "gtfs.zip")

gtfs_CITY <- read_gtfs(path)


gtfs_CITY

metro <-  filter_by_agency_id(gtfs_CITY, "METRO", keep = TRUE)

metro$shapes

unique(metro$shapes$shape_id)
unique(metro$trips[, .(route_id, shape_id)])


metro$stops

metro$stops$line_id <- sub("-.*", "", metro$stops$stop_id)

unique(metro$stops$line_id )



write_gtfs(
  metro,
  "./assets/CDMX/GTFS/metro.zip",
  files = NULL,
  standard_only = FALSE,
  as_dir = FALSE,
  overwrite = TRUE,
  quiet = TRUE
)

