import React from "react";
import { makeStyles } from "@mui/styles";

const useStyles = makeStyles({ root: { color: "red" } });

export const Page = () => {
  const classes = useStyles();
  return <div className={classes.root}>hello</div>;
};
