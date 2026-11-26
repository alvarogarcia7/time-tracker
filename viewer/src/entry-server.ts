// The page the Node editor server serves (make editor): the editor operations go over HTTP.
import "./styles.css";
import { startPage } from "./app";
import { httpApi } from "./httpApi";

startPage(httpApi());
