library(gtfstools)
library(ggplot2)


data_path <- system.file("extdata", package = "gtfstools")


ber_path <- file.path(data_path, "ber_gtfs.zip")


BER_gtfs <- read_gtfs(ber_path)
# 
# 
# S_BAHN <- filter_by_agency_id(BER_gtfs, "1", keep = TRUE)


write_gtfs(
  BER_gtfs,
  "./assets/BE/GTFS/be.zip",
  files = NULL,
  standard_only = FALSE,
  as_dir = FALSE,
  overwrite = TRUE,
  quiet = TRUE
)






